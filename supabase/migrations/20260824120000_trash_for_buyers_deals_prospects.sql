-- Delete, as a reversible act.
--
-- leads already had trashed/trashed_at and nothing in the UI ever set it. The
-- other three objects had no notion of deletion at all, so the only way to
-- remove a mistyped buyer was to leave it there forever. Adding the same two
-- columns everywhere means one mental model: the delete button trashes, the
-- Trash screen restores or purges.
--
-- Soft by default because the failure mode is asymmetric. Bulk-selecting 200
-- leads and hitting delete is one wrong click; DELETE cascades lead_notes,
-- lead_activity, lead_tasks and sdr_conversations, so a hard delete would take
-- the entire call history with it and nothing would bring it back.
--
-- What a *permanent* delete deliberately does NOT take with it, checked against
-- the FK graph rather than assumed:
--   telephony_opt_outs  -- no FK to leads at all, keyed on phone_key. Someone
--                          who replied STOP stays suppressed even if their lead
--                          record is purged and the number is re-imported later.
--                          This is the one that would be a TCPA problem.
--   sms_messages        -- lead_id SET NULL. The thread survives on phone_key.
--   call_log            -- lead_id SET NULL.
--   dnc_restore_log     -- lead_id SET NULL, so the "who took this off DNC and
--                          when" audit trail outlives the lead.
--   deals               -- lead_id SET NULL. Purging a seller does not delete
--                          the contract; $2.9M under contract should not hinge
--                          on someone tidying up the leads list.
alter table public.buyers
  add column if not exists trashed    boolean     not null default false,
  add column if not exists trashed_at timestamptz;

alter table public.deals
  add column if not exists trashed    boolean     not null default false,
  add column if not exists trashed_at timestamptz;

alter table public.prospects
  add column if not exists trashed    boolean     not null default false,
  add column if not exists trashed_at timestamptz;

-- Every list screen reads "not trashed", so index for that rather than for the
-- Trash screen, which is small by definition.
create index if not exists buyers_live_idx    on public.buyers    (team_id) where not trashed;
create index if not exists deals_live_idx     on public.deals     (team_id) where not trashed;
create index if not exists prospects_live_idx on public.prospects (team_id) where not trashed;
create index if not exists leads_live_idx     on public.leads     (team_id) where not trashed;

-- Keep trashed_at honest without making every caller remember it. A row that
-- says trashed with no timestamp cannot be sorted in the Trash screen, and a
-- restored row that keeps its old timestamp reads as still-deleted.
create or replace function public.stamp_trashed_at()
returns trigger
language plpgsql
set search_path to 'public', 'pg_catalog'
as $$
BEGIN
  IF NEW.trashed AND NOT COALESCE(OLD.trashed, false) THEN
    NEW.trashed_at := now();
  ELSIF NOT NEW.trashed THEN
    NEW.trashed_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

revoke all on function public.stamp_trashed_at() from anon, authenticated;

drop trigger if exists trg_leads_trashed_at     on public.leads;
drop trigger if exists trg_buyers_trashed_at    on public.buyers;
drop trigger if exists trg_deals_trashed_at     on public.deals;
drop trigger if exists trg_prospects_trashed_at on public.prospects;

create trigger trg_leads_trashed_at     before insert or update on public.leads
  for each row execute function public.stamp_trashed_at();
create trigger trg_buyers_trashed_at    before insert or update on public.buyers
  for each row execute function public.stamp_trashed_at();
create trigger trg_deals_trashed_at     before insert or update on public.deals
  for each row execute function public.stamp_trashed_at();
create trigger trg_prospects_trashed_at before insert or update on public.prospects
  for each row execute function public.stamp_trashed_at();

comment on column public.buyers.trashed    is 'Soft delete. Restore or purge from the Trash screen.';
comment on column public.deals.trashed     is 'Soft delete. Restore or purge from the Trash screen.';
comment on column public.prospects.trashed is 'Soft delete. Restore or purge from the Trash screen.';
