-- Trash for the two container objects: a bought prospect list, and a campaign.
--
-- Both already had a hard-delete path with a sharp edge on it:
--
--   prospects.list_id is ON DELETE CASCADE, so deleting a list destroys every
--   prospect in it. That is right for a purge and catastrophic as the default
--   gesture, since these lists are bought and run to thousands of rows.
--
--   broadcast_campaigns already refuses to be deleted once its audience is
--   materialised (broadcast_campaign_no_delete_after_materialise) because
--   broadcast_recipients is the record of who was and was not texted, and that
--   is the exact evidence a carrier asks for. So a sent campaign could never be
--   removed from the screen at all. Trash is what that case actually needed:
--   hide it, keep the ledger.
alter table public.prospect_lists
  add column if not exists trashed    boolean     not null default false,
  add column if not exists trashed_at timestamptz;

alter table public.broadcast_campaigns
  add column if not exists trashed    boolean     not null default false,
  add column if not exists trashed_at timestamptz;

create index if not exists prospect_lists_live_idx on public.prospect_lists (team_id) where not trashed;
create index if not exists broadcast_campaigns_live_idx on public.broadcast_campaigns (team_id) where not trashed;

drop trigger if exists trg_prospect_lists_trashed_at on public.prospect_lists;
drop trigger if exists trg_campaigns_trashed_at      on public.broadcast_campaigns;

create trigger trg_prospect_lists_trashed_at before insert or update on public.prospect_lists
  for each row execute function public.stamp_trashed_at();
create trigger trg_campaigns_trashed_at      before insert or update on public.broadcast_campaigns
  for each row execute function public.stamp_trashed_at();

comment on column public.prospect_lists.trashed is
  'Soft delete. Use set_prospect_list_trashed so the list and its prospects move together.';
comment on column public.broadcast_campaigns.trashed is
  'Soft delete. A materialised campaign can be trashed but never destroyed -- broadcast_recipients is the send record.';
