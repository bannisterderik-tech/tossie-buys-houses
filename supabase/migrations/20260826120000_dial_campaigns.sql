-- Saved, filtered calling lists.
--
-- The dialer queue today is one implicit list: everything due, plus everything
-- never scheduled. That is the right default and a poor way to run a session
-- with a purpose -- "call the 40 Savannah pre-foreclosures" or "ring the buyers
-- who fit 110 Hendricks" cannot be expressed at all.
--
-- Members are FROZEN at materialise, the same way broadcast campaigns are, and
-- for the same reason: a list that re-evaluates its filter changes length while
-- you work it, and then "38 of 80 called" is a sentence about nothing. The
-- filter is kept alongside the members so it is auditable, not so it re-runs.
create table if not exists public.dial_campaigns (
  id            uuid primary key default gen_random_uuid(),
  team_id       uuid not null references public.teams(id) on delete cascade,
  name          text not null,
  kind          text not null check (kind in ('sellers','buyers')),
  -- A buyer call list exists to pitch a specific property. Without the deal
  -- there is nothing to say on the call and no buy box to segment on, which is
  -- why this is a constraint rather than an optional field.
  deal_id       uuid references public.deals(id) on delete set null,
  filter        jsonb not null default '{}'::jsonb,
  status        text not null default 'active' check (status in ('active','paused','done')),
  materialised_at timestamptz,
  total_count     integer not null default 0,
  callable_count  integer not null default 0,
  skipped_count   integer not null default 0,
  created_by    uuid references public.profiles(id) on delete set null,
  trashed       boolean not null default false,
  trashed_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint dial_campaigns_buyers_need_deal
    check (kind <> 'buyers' or deal_id is not null),
  constraint dial_campaigns_name_not_blank check (btrim(name) <> '')
);

create table if not exists public.dial_campaign_members (
  id            uuid primary key default gen_random_uuid(),
  team_id       uuid not null references public.teams(id) on delete cascade,
  campaign_id   uuid not null references public.dial_campaigns(id) on delete cascade,
  lead_id       uuid references public.leads(id)  on delete cascade,
  buyer_id      uuid references public.buyers(id) on delete cascade,
  position      integer not null,
  match_score   integer,
  match_reasons text[],
  -- Frozen at materialise, exactly like broadcast_recipients.skip_reason: the
  -- record of why somebody was not callable when the list was built. The dialer
  -- still re-checks at dial time -- twilio-voice is the rail, this is the ledger.
  skip_reason   text,
  status        text not null default 'pending' check (status in ('pending','called','skipped')),
  outcome       text,
  called_at     timestamptz,
  created_at    timestamptz not null default now(),
  constraint dial_member_exactly_one_subject check (num_nonnulls(lead_id, buyer_id) = 1)
);

create unique index if not exists dial_member_lead_uniq
  on public.dial_campaign_members (campaign_id, lead_id) where lead_id is not null;
create unique index if not exists dial_member_buyer_uniq
  on public.dial_campaign_members (campaign_id, buyer_id) where buyer_id is not null;
create index if not exists dial_member_queue_idx
  on public.dial_campaign_members (campaign_id, status, position);
create index if not exists dial_campaigns_live_idx
  on public.dial_campaigns (team_id) where not trashed;

alter table public.dial_campaigns        enable row level security;
alter table public.dial_campaign_members enable row level security;

drop policy if exists dial_campaigns_team_all on public.dial_campaigns;
create policy dial_campaigns_team_all on public.dial_campaigns
  for all using (team_id = public.get_my_team_id())
  with check (team_id = public.get_my_team_id());

drop policy if exists dial_campaign_members_team_all on public.dial_campaign_members;
create policy dial_campaign_members_team_all on public.dial_campaign_members
  for all using (team_id = public.get_my_team_id())
  with check (team_id = public.get_my_team_id());

drop trigger if exists trg_dial_campaigns_touch on public.dial_campaigns;
create trigger trg_dial_campaigns_touch before update on public.dial_campaigns
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_dial_campaigns_trashed_at on public.dial_campaigns;
create trigger trg_dial_campaigns_trashed_at before insert or update on public.dial_campaigns
  for each row execute function public.stamp_trashed_at();

/**
 * Why a buyer cannot be CALLED, or null when they can be.
 *
 * Deliberately not buyer_skip_reason. That one governs SMS and turns on
 * consent_sms + tcpa_opt_in, which is the right rail for a text and the wrong
 * one for a phone call: a call to an established business contact about a
 * property is not what express written consent exists to govern, and gating it
 * on an SMS flag would silently make the buyers most worth ringing unreachable.
 *
 * An opt-out still stops the call. A STOP is nominally an SMS instruction, but
 * lead_is_dialable already treats suppression as covering calls too, and a
 * person who told us to stop should not have to say it twice in two channels.
 */
create or replace function public.buyer_call_skip_reason(b public.buyers)
returns text
language sql
stable
set search_path to 'public', 'pg_catalog'
as $$
  SELECT CASE
    WHEN b.trashed                                        THEN 'buyer_trashed'
    WHEN b.status <> 'active'                             THEN 'buyer_inactive'
    WHEN COALESCE(b.phone, b.phone_secondary) IS NULL     THEN 'no_phone'
    WHEN public.is_opted_out(b.team_id, b.phone)
      OR public.is_opted_out(b.team_id, b.phone_secondary) THEN 'opted_out'
    ELSE NULL
  END;
$$;

comment on table public.dial_campaigns is
  'A named, filtered calling list. Members are frozen at materialise.';
