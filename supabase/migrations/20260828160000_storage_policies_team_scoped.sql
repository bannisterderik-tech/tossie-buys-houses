-- Storage objects are rows in storage.objects, and without policies a private
-- bucket refuses everybody -- including the app. These scope every operation to
-- the caller's own team by reading the first folder of the object path.
--
-- The path convention every writer must follow is:
--     {team_id}/{lead|deal}/{subject_id}/{photo_id}.{ext}
-- The team id is FIRST precisely so a policy can check it without a join. A
-- caller who writes to another team's prefix is refused by the WITH CHECK, so
-- the convention is enforced rather than merely documented.

-- ── property photos ──────────────────────────────────────────────────────
drop policy if exists property_photos_read   on storage.objects;
drop policy if exists property_photos_insert on storage.objects;
drop policy if exists property_photos_update on storage.objects;
drop policy if exists property_photos_delete on storage.objects;

create policy property_photos_read on storage.objects for select to authenticated
  using (
    bucket_id = 'property-photos'
    and (storage.foldername(name))[1] = public.get_my_team_id()::text
    and (public.has_capability('leads.view') or public.has_capability('deals.view'))
  );

create policy property_photos_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'property-photos'
    and (storage.foldername(name))[1] = public.get_my_team_id()::text
    and (public.has_capability('leads.edit') or public.has_capability('deals.edit'))
  );

create policy property_photos_update on storage.objects for update to authenticated
  using (
    bucket_id = 'property-photos'
    and (storage.foldername(name))[1] = public.get_my_team_id()::text
    and (public.has_capability('leads.edit') or public.has_capability('deals.edit'))
  );

-- Deleting the object is how a seller's "take those down" is actually honoured,
-- so it tracks edit rather than the delete capability: the person who can
-- change the lead is the person on the phone being asked.
create policy property_photos_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'property-photos'
    and (storage.foldername(name))[1] = public.get_my_team_id()::text
    and (public.has_capability('leads.edit') or public.has_capability('deals.edit'))
  );

-- ── deal documents ───────────────────────────────────────────────────────
drop policy if exists deal_documents_read   on storage.objects;
drop policy if exists deal_documents_insert on storage.objects;
drop policy if exists deal_documents_delete on storage.objects;

create policy deal_documents_read on storage.objects for select to authenticated
  using (
    bucket_id = 'deal-documents'
    and (storage.foldername(name))[1] = public.get_my_team_id()::text
    and public.has_capability('deals.view')
  );

create policy deal_documents_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'deal-documents'
    and (storage.foldername(name))[1] = public.get_my_team_id()::text
    and public.has_capability('deals.edit')
  );

create policy deal_documents_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'deal-documents'
    and (storage.foldername(name))[1] = public.get_my_team_id()::text
    and public.has_capability('deals.edit')
  );
