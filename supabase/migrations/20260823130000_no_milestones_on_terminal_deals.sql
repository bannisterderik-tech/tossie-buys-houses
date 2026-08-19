-- A dead deal must not carry live deadlines.
--
-- sync_deal_milestones keys purely off the date columns, so a deal that died in
-- February still arms an "inspection ends" and a "Closing" milestone -- and the
-- reminder ladder in format.js is built to escalate on exactly those rows. On a
-- fresh install nobody notices; the moment the milestone worker ships it pages
-- the acquisitions lead about a contract the seller terminated six months ago,
-- and a reminder that is reliably wrong is a reminder people switch off. The
-- CRM import made this concrete: 12 of the 20 imported contracts are already
-- terminal, with closing dates months in the past.
--
-- Terminal here means the deal cannot come back on its own: closed, dead,
-- seller_terminated, terminated_inspection. buyer_fell_through is deliberately
-- NOT terminal -- that deal is still under contract and still has a real
-- closing date to hit with a different buyer, which is precisely when the
-- deadline matters most.
create or replace function public.sync_deal_milestones()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_catalog'
as $function$
DECLARE
  r record;
  v_terminal boolean := NEW.status IN ('closed','dead','seller_terminated','terminated_inspection');
BEGIN
  IF v_terminal THEN
    -- Drop what is still outstanding, keep what somebody already ticked off:
    -- a completed milestone is a record of something that actually happened.
    DELETE FROM public.deal_milestones m
     WHERE m.deal_id = NEW.id AND m.auto_managed AND m.completed_at IS NULL;
    RETURN NEW;
  END IF;

  FOR r IN
    SELECT * FROM (VALUES
      ('emd_due',        NEW.emd_due_date,        'Earnest money due'),
      ('inspection_end', NEW.inspection_end_date, 'Inspection period ends'),
      ('closing',        NEW.closing_date,        'Closing')
    ) AS v(kind, on_date, label)
  LOOP
    IF r.on_date IS NULL THEN
      DELETE FROM public.deal_milestones m
       WHERE m.deal_id = NEW.id AND m.kind = r.kind
         AND m.auto_managed AND m.completed_at IS NULL;
      CONTINUE;
    END IF;

    INSERT INTO public.deal_milestones (team_id, deal_id, kind, label, due_at, auto_managed)
    VALUES (
      NEW.team_id, NEW.id, r.kind, r.label,
      -- 17:00 on the date, not midnight. A contract deadline written as "the
      -- 12th" expires at the end of the 12th; a ladder anchored to midnight
      -- fires every rung a full day early.
      r.on_date::timestamp + interval '17 hours',
      true
    )
    ON CONFLICT (deal_id, kind) WHERE auto_managed DO UPDATE
      SET due_at = EXCLUDED.due_at,
          label  = EXCLUDED.label,
          reminders_sent_hours = CASE
            WHEN deal_milestones.due_at IS DISTINCT FROM EXCLUDED.due_at
              THEN '{}'::integer[]
            ELSE deal_milestones.reminders_sent_hours
          END
      WHERE deal_milestones.completed_at IS NULL;
  END LOOP;

  RETURN NEW;
END;
$function$;

-- Flagged in the security audit as anon-executable: these only ever run as triggers.
revoke all on function public.sync_deal_milestones() from anon, authenticated;
revoke all on function public.log_deal_status_change() from anon, authenticated;
