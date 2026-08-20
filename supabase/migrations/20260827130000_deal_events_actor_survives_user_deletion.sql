-- You could not delete a user account. At all.
--
-- deal_events is append-only, enforced by a BEFORE DELETE OR UPDATE trigger
-- declared FOR EACH STATEMENT. A statement trigger fires when the statement
-- runs, not when it matches rows -- and deleting an auth user makes Postgres
-- run "UPDATE deal_events SET actor_id = NULL WHERE actor_id = $1" to honour
-- the FK's ON DELETE SET NULL. Zero rows matched, the trigger fired anyway, and
-- the whole delete aborted with "deal_events is append-only".
--
-- Nobody hit it because nobody had tried to remove a teammate yet. Roles make
-- that a routine act -- a VA leaves and their access has to go with them.
--
-- The fix is to stop the audit log holding a live foreign key. An immutable
-- record of who did what should not have its actor rewritten by a referential
-- action, and it should not be able to veto an account deletion. Keeping the
-- raw uuid is also the more useful behaviour: the event still says which
-- account took the action after that account is gone.
alter table public.deal_events drop constraint if exists deal_events_actor_id_fkey;

comment on column public.deal_events.actor_id is
  'The acting user id. Deliberately not a foreign key: this table is append-only, '
  'so an ON DELETE SET NULL would both rewrite history and block user deletion.';
