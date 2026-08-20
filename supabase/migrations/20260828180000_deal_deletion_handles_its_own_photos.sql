-- Deleting a deal has to treat two kinds of photo differently, and a foreign
-- key cannot express the difference.
--
--   A photo that came from the lead belongs to the lead. Losing the deal should
--   just detach it -- that is ON DELETE SET NULL, which is already right.
--
--   A photo uploaded straight onto a deal that never had a lead has no other
--   home. SET NULL would leave it with neither subject, which the
--   property_photos_needs_a_subject check refuses -- so deleting such a deal
--   failed outright with a constraint violation.
--
-- BEFORE DELETE, so the homeless ones are gone before the foreign key's SET
-- NULL runs over whatever is left.
create or replace function public.delete_deal_only_photos()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_catalog'
as $$
BEGIN
  DELETE FROM public.property_photos
   WHERE deal_id = OLD.id AND lead_id IS NULL;
  RETURN OLD;
END;
$$;

revoke execute on function public.delete_deal_only_photos() from public, anon, authenticated;

drop trigger if exists trg_deal_deletes_its_own_photos on public.deals;
create trigger trg_deal_deletes_its_own_photos
  before delete on public.deals
  for each row execute function public.delete_deal_only_photos();

comment on function public.delete_deal_only_photos() is
  'Removes photos whose only subject was this deal. Photos that also belong to a lead are left for the FK to detach.';
