import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../supabase.js';
import { useCan } from '../lib/capabilities.jsx';
import { prepareImage, looksLikeAnImage, MAX_UPLOAD_BYTES } from '../lib/images.js';
import './photo-gallery.css';

/**
 * The photos of a house, on whichever record you are looking at.
 *
 * One component serves both subjects because they are the same pictures. A
 * lead is a house somebody might sell; a deal is that house under contract. So
 * photos taken while the lead was being worked have to be there when it becomes
 * a deal, without anybody re-uploading them — that carry-over is done in the
 * database, by a trigger on deals, not here. This component only ever writes
 * the subject it was handed, which is what makes the two cases identical from
 * the UI's side:
 *
 *   subject="lead" writes lead_id, and a trigger stamps deal_id if a deal
 *   already exists — so a photo added the day after the contract is signed
 *   still lands on the deal.
 *
 *   subject="deal" writes deal_id. A deal typed in from scratch, with no lead
 *   behind it, holds its own photos and nothing else needs to be true.
 *
 * The bucket is private. Nothing here stores a URL: every tile and every
 * lightbox image is a signed link minted on load and good for an hour, because
 * a saved signed URL is a credential that outlives the person it was minted
 * for — and these are pictures of the inside of somebody's house.
 */

const BUCKET = 'property-photos';
/** Long enough to browse a gallery, short enough that a copied link dies. */
const SIGNED_FOR = 60 * 60;

export default function PhotoGallery({ subject, subjectId, teamId, canEdit }) {
  const { can } = useCan();
  const [photos, setPhotos] = useState([]);
  const [urls, setUrls] = useState({});
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [progress, setProgress] = useState(null);
  const [open, setOpen] = useState(null);
  const [dragging, setDragging] = useState(null);
  const [over, setOver] = useState(false);
  const fileInput = useRef(null);

  // The caller knows better than we do — a lead page passes leads.edit, a deal
  // page passes deals.edit — but fall back to either so the component is not
  // silently read-only if somebody mounts it without the prop.
  const editable = canEdit ?? (can('leads.edit') || can('deals.edit'));
  const column = subject === 'deal' ? 'deal_id' : 'lead_id';

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('property_photos')
      .select('*')
      .eq(column, subjectId)
      .order('position')
      .order('created_at');

    if (error) { setErr(error.message); setLoading(false); return; }
    const rows = data ?? [];
    setPhotos(rows);
    setLoading(false);

    if (rows.length === 0) { setUrls({}); return; }

    // One round trip for every object on the page, thumbnails and full sizes
    // together. Signing them lazily per tile would be a request per photo and
    // a visible pop-in as each one resolved.
    const paths = [];
    for (const p of rows) {
      paths.push(p.storage_path);
      if (p.thumb_path) paths.push(p.thumb_path);
    }
    const { data: signed, error: sErr } = await supabase.storage
      .from(BUCKET).createSignedUrls(paths, SIGNED_FOR);
    if (sErr) { setErr(storageHint(sErr)); return; }
    const map = {};
    for (const s of signed ?? []) if (s.signedUrl && !s.error) map[s.path] = s.signedUrl;
    setUrls(map);
  }, [column, subjectId]);

  useEffect(() => { load(); }, [load]);

  // Arrow keys and Escape in the lightbox. Bound on window rather than the
  // overlay so it works without the overlay having to hold focus.
  useEffect(() => {
    if (open == null) return;
    function onKey(e) {
      if (e.key === 'Escape') setOpen(null);
      if (e.key === 'ArrowRight') setOpen((i) => Math.min(photos.length - 1, i + 1));
      if (e.key === 'ArrowLeft') setOpen((i) => Math.max(0, i - 1));
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, photos.length]);

  async function upload(files) {
    setErr(null);
    const picked = Array.from(files ?? []);
    const list = picked.filter(looksLikeAnImage);
    // Silence was the worst version of this. Dropping a folder, or a file the
    // browser could not describe, filtered everything out and returned — the
    // drop zone lit up, nothing uploaded, and no reason was ever given.
    if (list.length === 0) {
      setErr(picked.length
        ? `Nothing there we could read as a photo${picked.length === 1 ? ` (${picked[0].name})` : ''}. JPG, PNG, WEBP, HEIC and GIF all work; folders and shortcuts do not — open the folder and select the files inside it.`
        : 'Nothing came through in that drop. Some apps hand over a link rather than the file; try saving the photo first, or use the button to choose it.');
      return;
    }
    if (list.length < picked.length) {
      setErr(`${picked.length - list.length} of ${picked.length} skipped — not photos.`);
    }

    const { data: who } = await supabase.auth.getUser();
    const base = photos.reduce((m, p) => Math.max(m, p.position ?? 0), -1) + 1;
    const failures = [];

    for (let i = 0; i < list.length; i += 1) {
      const file = list[i];
      setProgress({ done: i, total: list.length, name: file.name });

      // Resizing happens first, so the size check is against what is actually
      // being sent — a 30MB original that shrinks to 400KB is a fine upload
      // and refusing it on the raw size would be wrong.
      let prepared;
      try {
        prepared = await prepareImage(file);
      } catch (e) {
        failures.push(`${file.name}: ${e.message}`);
        continue;
      }
      if (prepared.full.size > MAX_UPLOAD_BYTES) {
        failures.push(`${file.name}: too large even after resizing`);
        continue;
      }

      // The id is minted here rather than taken from the insert, because the
      // object key has to exist before the row that points at it does.
      const photoId = crypto.randomUUID();
      const dir = `${teamId}/${subject}/${subjectId}`;
      const path = `${dir}/${photoId}.${prepared.ext}`;
      const thumbPath = prepared.thumb ? `${dir}/${photoId}-t.jpg` : null;

      const { error: upErr } = await supabase.storage
        .from(BUCKET).upload(path, prepared.full, { contentType: prepared.mime });
      if (upErr) { failures.push(`${file.name}: ${storageHint(upErr)}`); continue; }

      if (thumbPath) {
        // A missing thumbnail is a slow tile, not a broken photo, so this
        // failure is swallowed and thumb_path stays null.
        const { error: tErr } = await supabase.storage
          .from(BUCKET).upload(thumbPath, prepared.thumb, { contentType: 'image/jpeg' });
        if (tErr) prepared.thumb = null;
      }

      const { error } = await supabase.from('property_photos').insert({
        id: photoId,
        team_id: teamId,
        [column]: subjectId,
        bucket: BUCKET,
        storage_path: path,
        thumb_path: prepared.thumb ? thumbPath : null,
        file_name: file.name,
        mime_type: prepared.mime,
        size_bytes: prepared.full.size,
        width: prepared.width,
        height: prepared.height,
        position: base + i,
        uploaded_by: who?.user?.id ?? null,
      });

      if (error) {
        // The row is the record. A file with no row is invisible to every
        // screen and to RLS, so it goes back out rather than sitting in the
        // bucket findable by nothing and billable forever.
        await supabase.storage.from(BUCKET).remove([path, thumbPath].filter(Boolean));
        failures.push(`${file.name}: ${error.message}`);
      }
    }

    setProgress(null);
    if (failures.length) setErr(failures.join(' · '));
    await load();
  }

  async function remove(photo) {
    const alsoOnLead = subject === 'deal' && photo.lead_id;
    const warning = alsoOnLead
      ? 'This photo is also on the lead this deal came from. Deleting removes it from both.'
      : 'The file is deleted too.';
    if (!window.confirm(`Delete this photo? ${warning}`)) return;

    // Row first. If the object delete fails afterwards the worst case is an
    // orphaned file; the other order leaves a row pointing at nothing, which
    // every screen renders as a broken tile.
    const { error } = await supabase.from('property_photos').delete().eq('id', photo.id);
    if (error) { setErr(error.message); return; }
    await supabase.storage.from(BUCKET).remove([photo.storage_path, photo.thumb_path].filter(Boolean));
    setOpen(null);
    await load();
  }

  async function saveCaption(photo, caption) {
    const next = caption.trim() || null;
    if (next === (photo.caption ?? null)) return;
    const { error } = await supabase.from('property_photos')
      .update({ caption: next }).eq('id', photo.id);
    if (error) { setErr(error.message); return; }
    setPhotos((ps) => ps.map((p) => (p.id === photo.id ? { ...p, caption: next } : p)));
  }

  /** Writes whatever order the array is currently in. */
  async function persistOrder(ordered) {
    const changed = ordered
      .map((p, i) => ({ p, i }))
      .filter(({ p, i }) => p.position !== i);
    if (changed.length === 0) return;
    const results = await Promise.all(changed.map(({ p, i }) =>
      supabase.from('property_photos').update({ position: i }).eq('id', p.id)));
    const failed = results.find((r) => r.error);
    if (failed) { setErr(failed.error.message); await load(); return; }
    setPhotos(ordered.map((p, i) => ({ ...p, position: i })));
  }

  function reorder(from, to) {
    if (from === to || from == null || to == null) return;
    const next = photos.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setPhotos(next);
    persistOrder(next);
  }

  const label = subject === 'deal' ? 'deal' : 'lead';

  return (
    <div className="card">
      <h2 className="galleryhead">
        <span>Photos {photos.length > 0 && `· ${photos.length}`}</span>
        {editable && photos.length > 0 && (
          <button className="btn ghost" onClick={() => fileInput.current?.click()}>Add more</button>
        )}
      </h2>
      <p className="cardnote">
        {subject === 'lead'
          ? 'Stored privately and resized on the way in. These follow the property — put a contract on this lead and the same photos are on the deal, including any added afterwards.'
          : 'Stored privately and resized on the way in. Photos taken while this was still a lead are already here; anything added now belongs to the deal.'}
      </p>

      <div className="body">
        {err && <div className="err">{err}</div>}

        {editable && (
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            multiple
            hidden
            // Copied before the reset, not after. e.target.files is a live
            // FileList owned by the input, so clearing value to allow the same
            // file to be re-picked empties the list we are holding — and
            // upload() then sees nothing at all.
            onChange={(e) => {
              const chosen = Array.from(e.target.files ?? []);
              e.target.value = '';
              upload(chosen);
            }}
          />
        )}

        {progress && (
          <div className="uploading">
            Uploading {progress.done + 1} of {progress.total} — {progress.name}
            <div className="bar"><span style={{ width: `${(progress.done / progress.total) * 100}%` }} /></div>
          </div>
        )}

        {loading ? (
          <p className="colempty">Loading photos…</p>
        ) : photos.length === 0 ? (
          editable ? (
            <div
              className={`dropzone${over ? ' over' : ''}`}
              onClick={() => fileInput.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setOver(true); }}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => { e.preventDefault(); setOver(false); upload(e.dataTransfer.files); }}
            >
              <strong>Drop photos here</strong>
              <span>or click to choose. Several at once is fine — they are resized in the browser before upload, so a phone full of 8MB pictures is not a problem.</span>
            </div>
          ) : (
            <p className="colempty">No photos on this {label}.</p>
          )
        ) : (
          <div
            className={`photogrid${over ? ' over' : ''}`}
            onDragOver={editable ? (e) => { e.preventDefault(); setOver(true); } : undefined}
            onDragLeave={editable ? () => setOver(false) : undefined}
            onDrop={editable ? (e) => {
              setOver(false);
              // Files from the desktop, not a tile being shuffled.
              if (e.dataTransfer.files?.length) { e.preventDefault(); upload(e.dataTransfer.files); }
            } : undefined}
          >
            {photos.map((p, i) => (
              <figure
                key={p.id}
                className={`phototile${dragging === i ? ' dragging' : ''}`}
                draggable={editable}
                onDragStart={() => setDragging(i)}
                onDragEnd={() => setDragging(null)}
                onDragOver={(e) => { if (dragging != null) e.preventDefault(); }}
                onDrop={(e) => {
                  if (dragging == null) return;
                  e.preventDefault();
                  e.stopPropagation();
                  reorder(dragging, i);
                  setDragging(null);
                }}
              >
                <button className="shot" onClick={() => setOpen(i)}>
                  {urls[p.thumb_path] || urls[p.storage_path] ? (
                    <img
                      src={urls[p.thumb_path] || urls[p.storage_path]}
                      alt={p.caption || p.file_name || 'Property photo'}
                      loading="lazy"
                    />
                  ) : (
                    <span className="missing">unavailable</span>
                  )}
                </button>
                {i === 0 && <span className="badge ok cover">Cover</span>}
                {p.caption && <figcaption>{p.caption}</figcaption>}
              </figure>
            ))}
          </div>
        )}

        {photos.length > 1 && editable && (
          <p className="fine" style={{ marginTop: 8 }}>
            Drag a photo to reorder. The first one is the cover.
          </p>
        )}
      </div>

      {open != null && photos[open] && (
        <Lightbox
          photo={photos[open]}
          url={urls[photos[open].storage_path]}
          index={open}
          count={photos.length}
          editable={editable}
          onPrev={() => setOpen((n) => Math.max(0, n - 1))}
          onNext={() => setOpen((n) => Math.min(photos.length - 1, n + 1))}
          onClose={() => setOpen(null)}
          onCaption={(c) => saveCaption(photos[open], c)}
          onDelete={() => remove(photos[open])}
          onMakeCover={open === 0 ? null : () => { reorder(open, 0); setOpen(0); }}
        />
      )}
    </div>
  );
}

function Lightbox({
  photo, url, index, count, editable,
  onPrev, onNext, onClose, onCaption, onDelete, onMakeCover,
}) {
  const [caption, setCaption] = useState(photo.caption ?? '');
  useEffect(() => { setCaption(photo.caption ?? ''); }, [photo.id, photo.caption]);

  return (
    <div className="lightbox" onClick={onClose}>
      <div className="frame" onClick={(e) => e.stopPropagation()}>
        <div className="stage">
          {index > 0 && <button className="nav prev" onClick={onPrev} aria-label="Previous">‹</button>}
          {url
            ? <img src={url} alt={photo.caption || photo.file_name || 'Property photo'} />
            : <p className="colempty">This image could not be loaded.</p>}
          {index < count - 1 && <button className="nav next" onClick={onNext} aria-label="Next">›</button>}
        </div>

        <div className="lightbar">
          <span className="fine">
            {index + 1} of {count}
            {photo.file_name ? ` · ${photo.file_name}` : ''}
            {photo.width ? ` · ${photo.width}×${photo.height}` : ''}
          </span>

          {editable ? (
            <input
              className="captionfield"
              value={caption}
              placeholder="Add a caption — what is this?"
              onChange={(e) => setCaption(e.target.value)}
              onBlur={() => onCaption(caption)}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
            />
          ) : (
            <span>{photo.caption || ''}</span>
          )}

          <span className="lightactions">
            {editable && onMakeCover && (
              <button className="btn ghost" onClick={onMakeCover}>Make cover</button>
            )}
            {editable && <button className="btn ghost danger" onClick={onDelete}>Delete</button>}
            <button className="btn ghost" onClick={onClose}>Close</button>
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * Storage errors arrive as one line with no hint of which half of the setup is
 * missing, and the two halves fail identically from the user's side.
 */
function storageHint(error) {
  const msg = error?.message || 'Upload failed';
  if (/bucket/i.test(msg) && /not found|does not exist/i.test(msg)) {
    return `The "${BUCKET}" storage bucket does not exist. It has to be created as a PRIVATE bucket — these are photos of the inside of somebody's house, and a public bucket puts them behind a guessable URL.`;
  }
  if (/row-level security|policy|not authorized|Unauthorized/i.test(msg)) {
    return `Storage refused this (${msg}). The "${BUCKET}" bucket needs policies on storage.objects scoped to this team — the object key starts with the team id for exactly that. Not USING (true), which would make every photo on the project readable by anyone who can sign in.`;
  }
  return msg;
}
