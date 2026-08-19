-- ============================================================================
-- Releasing a number — the soft-delete columns and the rails around them.
-- ============================================================================
-- Releasing a Twilio number is the only operation in this build that is truly
-- irreversible from inside the app. The number goes back into Twilio's pool,
-- billing stops, and anyone can claim it the same afternoon. From then on every
-- call and text a seller sends to it reaches a stranger, and there is no button
-- anywhere that undoes it.
--
-- THE LOAD-BEARING DECISION: A RELEASE IS A SOFT DELETE, NEVER A ROW DELETE.
--
-- sms_messages.phone_number_id and telephony_settings.default_number_id are
-- both ON DELETE SET NULL. Deleting the phone_numbers row would therefore not
-- fail loudly — it would succeed, and quietly null out the link on every
-- message that was ever sent or received on that number. The thread text would
-- survive; which of our numbers it happened on would not.
--
-- That matters because of what 20260818120000 already decided about this data:
-- `authenticated` is deliberately denied DELETE on sms_messages and call_log,
-- on the grounds that a thread is the evidence of what was said to a homeowner
-- and a UI that can quietly erase it is worth less than one that cannot. A
-- release that severed phone_number_id would be the same evidence loss arriving
-- by a different door — one row deleted instead of a thousand, with identical
-- consequences the day somebody claims we texted them after they said STOP and
-- we can no longer say from where.
--
-- So the row stays forever. released_at is what makes it stop being operational.
--
-- Three columns, no state machine: released_at IS NULL means live, and that one
-- predicate is what every operational path filters on. A `status` enum would
-- have invited a third state nobody defined.
-- ============================================================================

ALTER TABLE public.phone_numbers
  ADD COLUMN IF NOT EXISTS released_at    timestamptz,
  -- ON DELETE SET NULL rather than CASCADE or RESTRICT: if the operator who
  -- released the number is later removed from auth.users, losing their name is
  -- acceptable — losing the record that the release happened is not, and
  -- CASCADE here would delete the phone_numbers row itself.
  ADD COLUMN IF NOT EXISTS released_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS release_reason text;

COMMENT ON COLUMN public.phone_numbers.released_at IS
  'NULL means the number is live. Non-NULL means it was released back to Twilio''s pool and can no longer be used to send, dial or be made primary. Irreversible: the row is kept only so the messages and calls that happened on this number keep their link.';
COMMENT ON COLUMN public.phone_numbers.release_reason IS
  'Free text the operator typed at release time. Not a category — the useful version of this is always a sentence.';

-- ── the primary index question ──────────────────────────────────────────────
-- phone_numbers_one_primary_idx is UNIQUE(team_id) WHERE is_primary. The
-- obvious move on adding a soft-delete flag is to narrow it to
-- `WHERE is_primary AND released_at IS NULL`. That is the wrong change here,
-- and the reasoning is worth writing down because it looks backwards.
--
-- Narrowing the index would ALLOW a released row to keep is_primary = true,
-- alongside a live row that is also primary. Two rows would then satisfy
-- `is_primary`, which is precisely the state the index exists to make
-- impossible — and it is not theoretical, because three call sites pick the
-- sending number with a bare is_primary test:
--
--   twilio-send-sms   .eq('is_primary', true)
--   twilio-voice      numbers.find(n => n.is_primary)
--   MessagesPage      numbers.find(n => n.is_primary)
--
-- Any of those could have picked the released row.
--
-- So the index is left exactly as it was, and the invariant is stated directly
-- instead: a released number is not primary. With that CHECK in place,
-- `WHERE is_primary` already implies `released_at IS NULL`, so every existing
-- reader of is_primary stays correct without being touched. The constraint is
-- doing the work the narrowed index would only have pretended to do.
--
-- The release action refuses to release a primary number and tells the operator
-- to designate a new primary first; this constraint is what makes that refusal
-- a guarantee rather than a convention, including for anything that writes the
-- table without going through the edge function.
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'phone_numbers_released_not_primary'
      AND conrelid = 'public.phone_numbers'::regclass
  ) THEN
    ALTER TABLE public.phone_numbers
      ADD CONSTRAINT phone_numbers_released_not_primary
      CHECK (NOT (is_primary AND released_at IS NOT NULL));
  END IF;
END $do$;

-- ── no new index, and why ───────────────────────────────────────────────────
-- The common lookup this adds is "the team's live numbers":
--   WHERE team_id = $1 AND released_at IS NULL
-- and the tempting index is `(team_id) WHERE released_at IS NULL`.
--
-- Not added. Tossie owns a handful of numbers on one team — the whole table is
-- single-digit rows and every caller reads essentially all of it, so the
-- planner will sequential-scan regardless and an index would be dead weight
-- that still has to be kept in step with the column. Worse, an unused index on
-- a tiny table reads to the next person as evidence the table is large, which
-- is exactly the wrong thing to imply about the one table where the honest
-- answer is "just look at all of them" (twilio-webhook already does).
--
-- The condition under which this changes: if phone_numbers ever holds more
-- than a few dozen rows — a DID pool for local presence would do it — the
-- index to add is `CREATE INDEX ON public.phone_numbers(team_id) WHERE
-- released_at IS NULL`. Nothing about the columns above needs to change first.

-- ── marking a row released is not something the browser may do ──────────────
-- The order of operations in the release action is: tell Twilio first, mark the
-- row only after Twilio confirms. Marking first would leave a number that still
-- bills and still rings but is invisible to the app — a line nobody is watching
-- that a seller can still reach.
--
-- An UPDATE straight from the browser is that same failure with no Twilio call
-- at all, and `authenticated` holds UPDATE on this table because the rest of it
-- (label, A2P status, forwarding) is operator-managed. Column-level grants
-- cannot express "all columns except these three" without revoking the table
-- grant and re-granting a list that the next migration to add a column will
-- silently break, so the rule is a trigger instead.
--
-- Service role is unaffected: it is how the edge function writes the mark after
-- Twilio has confirmed, and it is the only thing that should be able to.
CREATE OR REPLACE FUNCTION public.phone_numbers_guard_release()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  IF current_user <> 'authenticated' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.released_at IS NOT NULL OR NEW.released_by IS NOT NULL OR NEW.release_reason IS NOT NULL THEN
      RAISE EXCEPTION 'A number cannot be recorded as already released. Releasing happens through the twilio-numbers function, which calls Twilio first.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;

  -- IS DISTINCT FROM, not <>, so a NULL on either side counts as a change
  -- rather than evaluating to NULL and letting the write through.
  IF NEW.released_at    IS DISTINCT FROM OLD.released_at
     OR NEW.released_by IS DISTINCT FROM OLD.released_by
     OR NEW.release_reason IS DISTINCT FROM OLD.release_reason THEN
    RAISE EXCEPTION 'Release marks are set by the twilio-numbers function after Twilio confirms the release, and are never edited afterwards. Marking a row released here would leave a number that still bills and still rings but is invisible to the app.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS phone_numbers_guard_release ON public.phone_numbers;
CREATE TRIGGER phone_numbers_guard_release
  BEFORE INSERT OR UPDATE ON public.phone_numbers
  FOR EACH ROW EXECUTE FUNCTION public.phone_numbers_guard_release();

-- Trigger functions run as the table owner when the trigger fires and never
-- consult EXECUTE grants, so revoking costs nothing and closes the REST
-- endpoint Supabase would otherwise publish at /rest/v1/rpc/<name>. Same
-- reasoning as 20260817120200; this is the fifth function to need it.
REVOKE ALL ON FUNCTION public.phone_numbers_guard_release() FROM PUBLIC, anon, authenticated;

-- ── the settings row must not point at a released number ────────────────────
-- telephony_settings.default_number_id is the number the send and dial paths
-- pick when the caller does not name one. Left pointing at a released number it
-- would resolve to a row that the `released_at IS NULL` filter then rejects,
-- and the operator would get "no sending number is configured" while the
-- dropdown on the settings page still showed a number selected.
--
-- The release action clears it in the same write that marks the row, and says
-- so in its response, because clearing to NULL is the safe direction: the send
-- path refuses out loud rather than silently promoting some other number that
-- the seller has never seen. This is enforced in the function rather than by a
-- trigger here because it is a decision with a sentence attached, and the
-- operator needs to be told it happened.
COMMENT ON COLUMN public.telephony_settings.default_number_id IS
  'The number outbound SMS and calls use when the caller does not name one. Cleared to NULL when that number is released — a stale pointer here reads to the send path as "no number", which is the safe way to fail.';
