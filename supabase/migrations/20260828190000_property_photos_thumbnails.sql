-- A grid that loads twenty 4MB phone photos is not a gallery, it is a stall,
-- and Storage image transformations are a paid add-on this project does not
-- have. So the browser resizes twice on upload and we keep both objects: a
-- ~40KB thumbnail for the grid and a capped-2000px copy for the lightbox.
--
-- Nullable on purpose. HEIC is what an iPhone actually hands over and no
-- desktop browser can decode it to a canvas, so those upload untouched and the
-- grid falls back to storage_path. Better a heavy tile than a refused upload.
alter table public.property_photos
  add column if not exists thumb_path text;

comment on column public.property_photos.thumb_path is
  'Small copy for grid tiles. Null when the browser could not decode the original (HEIC) — read storage_path instead.';
