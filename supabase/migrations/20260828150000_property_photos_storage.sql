-- Photos of the house, on the lead and then on the deal.
--
-- PRIVATE buckets, not public. These are photographs of people's homes, often
-- distressed, frequently occupied, taken during a conversation about why they
-- need to sell. A public bucket means a guessable URL to the inside of a
-- stranger's house, and there is no version of this product where that is an
-- acceptable default. Everything is served through short-lived signed URLs.
--
-- deal-documents is created here too: deal_documents.bucket has defaulted to
-- 'deal-documents' since deals shipped and the bucket was never created, so any
-- attempt to attach a contract would have failed at upload. Nobody noticed
-- because nothing has tried yet.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('property-photos', 'property-photos', false, 26214400,
   array['image/jpeg','image/png','image/webp','image/heic','image/heif']),
  ('deal-documents',  'deal-documents',  false, 26214400,
   array['application/pdf','image/jpeg','image/png','image/webp',
         'application/msword',
         'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

/**
 * One photo of one property.
 *
 * Carries BOTH lead_id and deal_id rather than being copied between two tables,
 * because a photo taken while qualifying the seller is the same photograph the
 * dispo blast sends out. Copying would mean two rows, two storage objects and
 * two places to delete from when the seller asks for them to be taken down.
 *
 * At least one of the two must be set. A photo attached to neither is an
 * orphan nobody can find and nobody can delete.
 */
create table if not exists public.property_photos (
  id            uuid primary key default gen_random_uuid(),
  team_id       uuid not null references public.teams(id) on delete cascade,
  lead_id       uuid references public.leads(id) on delete cascade,
  deal_id       uuid references public.deals(id) on delete set null,
  bucket        text not null default 'property-photos',
  storage_path  text not null unique,
  file_name     text,
  caption       text,
  -- Lowest sorts first and position 0 is the cover shot. Kept as a plain
  -- integer the UI rewrites on reorder rather than a fractional index: these
  -- galleries are twenty photos, not twenty thousand.
  position      integer not null default 0,
  mime_type     text,
  size_bytes    bigint,
  width         integer,
  height        integer,
  uploaded_by   uuid,
  created_at    timestamptz not null default now(),
  constraint property_photos_needs_a_subject
    check (num_nonnulls(lead_id, deal_id) >= 1)
);

create index if not exists property_photos_lead_idx on public.property_photos (lead_id, position, created_at);
create index if not exists property_photos_deal_idx on public.property_photos (deal_id, position, created_at);

alter table public.property_photos enable row level security;

-- Seeing the photos follows seeing the record they hang off. Adding or removing
-- one is editing that record, not deleting it -- a VA who can update a lead can
-- photograph the house, which is most of the point.
drop policy if exists property_photos_select on public.property_photos;
drop policy if exists property_photos_write  on public.property_photos;
create policy property_photos_select on public.property_photos for select
  using (team_id = public.get_my_team_id()
     and (public.has_capability('leads.view') or public.has_capability('deals.view')));
create policy property_photos_write on public.property_photos for all
  using (team_id = public.get_my_team_id()
     and (public.has_capability('leads.edit') or public.has_capability('deals.edit')))
  with check (team_id = public.get_my_team_id()
     and (public.has_capability('leads.edit') or public.has_capability('deals.edit')));

/**
 * Photos follow the lead onto the deal.
 *
 * This is the whole reason both columns live on one row. Acquisitions
 * photographs the house on the walkthrough; dispo needs exactly those photos to
 * sell it, and asking someone to re-upload twenty pictures they already took is
 * how a deal goes out with no photos attached.
 *
 * Only claims photos that are not already on a deal, so re-running it or
 * creating a second deal from the same lead cannot steal them from the first.
 */
create or replace function public.attach_lead_photos_to_deal()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_catalog'
as $$
BEGIN
  IF NEW.lead_id IS NOT NULL THEN
    UPDATE public.property_photos
       SET deal_id = NEW.id
     WHERE lead_id = NEW.lead_id AND deal_id IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

revoke execute on function public.attach_lead_photos_to_deal() from public, anon, authenticated;

drop trigger if exists trg_deal_inherits_lead_photos on public.deals;
create trigger trg_deal_inherits_lead_photos
  after insert on public.deals
  for each row execute function public.attach_lead_photos_to_deal();

/**
 * And the other direction in time: a photo added to a lead that ALREADY has a
 * deal should land on the deal too, rather than only being visible to whoever
 * is still working the lead.
 */
create or replace function public.attach_photo_to_existing_deal()
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

revoke execute on function public.attach_photo_to_existing_deal() from public, anon, authenticated;

drop trigger if exists trg_photo_joins_existing_deal on public.property_photos;
create trigger trg_photo_joins_existing_deal
  before insert on public.property_photos
  for each row execute function public.attach_photo_to_existing_deal();

comment on table public.property_photos is
  'Property photographs. Private bucket, signed URLs only. A photo carries both lead_id and deal_id so it follows the property through conversion rather than being copied.';
