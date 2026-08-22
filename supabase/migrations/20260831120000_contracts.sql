-- Generated purchase agreements.
--
-- Tossie's template is a Word file with blanks in it, filled in by hand for
-- every offer. The facts being typed -- address, seller name, price, closing
-- date -- are already on the lead, so typing them again is both slower and the
-- place transcription errors get into a binding document.
--
-- TWO COLUMNS RATHER THAN ONE, and the distinction is the whole design:
--
--   fields  the merge values, as data. Structured, queryable, and what a
--           regenerate reads.
--   body    the rendered document, as HTML. Editable afterwards.
--
-- Storing only fields would mean the operator can never touch the wording, and
-- every deal has one clause somebody negotiated. Storing only body would mean
-- the price is a string inside a paragraph, unqueryable, and a regenerate would
-- have nothing to work from. Keeping both means Generate writes body from
-- fields, and after that the body is the document -- edited freely, and marked
-- as edited so nobody is surprised when regenerating discards their changes.
create table if not exists public.contracts (
  id           uuid primary key default gen_random_uuid(),
  team_id      uuid not null references public.teams(id) on delete cascade,

  -- Same shape as property_photos, and for the same reason: a contract written
  -- against a lead has to still be there when that lead becomes a deal. The
  -- trigger below carries it across exactly as the photo one does.
  lead_id      uuid references public.leads(id) on delete cascade,
  deal_id      uuid references public.deals(id) on delete set null,

  template_key text not null default 'psa_v1',
  title        text,

  status       text not null default 'draft'
                 check (status in ('draft','sent','signed','void')),

  fields       jsonb not null default '{}'::jsonb,
  body         text,
  -- Set the moment somebody edits the rendered text, so Generate can warn
  -- before it throws that work away.
  body_edited  boolean not null default false,

  created_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint contracts_needs_a_subject check (num_nonnulls(lead_id, deal_id) >= 1)
);

create index if not exists contracts_lead_idx on public.contracts (lead_id, created_at desc);
create index if not exists contracts_deal_idx on public.contracts (deal_id, created_at desc);

alter table public.contracts enable row level security;

-- An offer is a lead action, so it tracks leads.edit rather than inventing a
-- capability. Dispositions can read one (they need to know what was signed)
-- through deals.view.
drop policy if exists contracts_select on public.contracts;
drop policy if exists contracts_write  on public.contracts;
create policy contracts_select on public.contracts for select
  using (team_id = public.get_my_team_id()
     and (public.has_capability('leads.view') or public.has_capability('deals.view')));
create policy contracts_write on public.contracts for all
  using (team_id = public.get_my_team_id()
     and (public.has_capability('leads.edit') or public.has_capability('deals.edit')))
  with check (team_id = public.get_my_team_id()
     and (public.has_capability('leads.edit') or public.has_capability('deals.edit')));

drop trigger if exists trg_contracts_touch on public.contracts;
create trigger trg_contracts_touch before update on public.contracts
  for each row execute function public.touch_updated_at();

-- Carry a lead's contracts onto the deal made from it, and catch the other
-- direction in time too. Identical reasoning to property_photos: the document
-- that created the deal should be attached to the deal.
create or replace function public.attach_lead_contracts_to_deal()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_catalog'
as $$
BEGIN
  IF NEW.lead_id IS NOT NULL THEN
    UPDATE public.contracts
       SET deal_id = NEW.id
     WHERE lead_id = NEW.lead_id AND deal_id IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

revoke execute on function public.attach_lead_contracts_to_deal() from public, anon, authenticated;

drop trigger if exists trg_deal_inherits_lead_contracts on public.deals;
create trigger trg_deal_inherits_lead_contracts
  after insert on public.deals
  for each row execute function public.attach_lead_contracts_to_deal();

create or replace function public.attach_contract_to_existing_deal()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_catalog'
as $$
BEGIN
  IF NEW.lead_id IS NOT NULL AND NEW.deal_id IS NULL THEN
    SELECT d.id INTO NEW.deal_id
      FROM public.deals d
     WHERE d.lead_id = NEW.lead_id AND NOT d.trashed
     ORDER BY d.created_at DESC
     LIMIT 1;
  END IF;
  RETURN NEW;
END;
$$;

revoke execute on function public.attach_contract_to_existing_deal() from public, anon, authenticated;

drop trigger if exists trg_contract_joins_existing_deal on public.contracts;
create trigger trg_contract_joins_existing_deal
  before insert on public.contracts
  for each row execute function public.attach_contract_to_existing_deal();

-- The same lesson property_photos taught: ON DELETE SET NULL would leave a
-- deal-only contract with no subject at all, which the check constraint
-- refuses -- so deleting such a deal would fail outright. A foreign key cannot
-- say "null it if there is a lead, delete it if there is not".
create or replace function public.delete_deal_only_contracts()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_catalog'
as $$
BEGIN
  DELETE FROM public.contracts
   WHERE deal_id = OLD.id AND lead_id IS NULL;
  RETURN OLD;
END;
$$;

revoke execute on function public.delete_deal_only_contracts() from public, anon, authenticated;

drop trigger if exists trg_deal_deletes_its_own_contracts on public.deals;
create trigger trg_deal_deletes_its_own_contracts
  before delete on public.deals
  for each row execute function public.delete_deal_only_contracts();

comment on table public.contracts is
  'Generated purchase agreements. fields holds the merge values; body holds the rendered, editable document. Follows a lead into its deal.';
