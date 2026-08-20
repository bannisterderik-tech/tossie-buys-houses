-- The same trap as deal_events.actor_id, one column over, and this one is
-- reachable from the UI: "Delete forever" on a deal in Trash.
--
-- deal_events is append-only via a FOR EACH STATEMENT trigger. Deleting a deal
-- makes Postgres run "UPDATE deal_events SET deal_id = NULL WHERE deal_id = $1"
-- to honour ON DELETE SET NULL; a statement trigger fires on the statement, not
-- on matched rows, so it raises "deal_events is append-only" and aborts the
-- delete. Even a deal with no events at all could not be destroyed.
--
-- Found by a test that created a throwaway deal and tried to clean it up. It
-- would otherwise have surfaced the first time somebody emptied the Trash.
--
-- Same fix and same reasoning as the actor_id one: an immutable log should not
-- hold a live foreign key. Keeping the raw uuid means an event still records
-- which deal it belonged to after that deal is gone, which is the point of
-- keeping the log at all.
alter table public.deal_events drop constraint if exists deal_events_deal_id_fkey;

comment on column public.deal_events.deal_id is
  'The deal this event belongs to. Deliberately not a foreign key: the table is '
  'append-only, so ON DELETE SET NULL would both rewrite history and make deals '
  'undeletable.';
