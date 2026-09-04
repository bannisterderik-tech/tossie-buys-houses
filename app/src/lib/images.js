/**
 * Turning a phone photo into something a grid can actually load.
 *
 * A picture taken on a modern handset is 3–12MB and 4000px wide. Twenty of them
 * is a gallery that takes half a minute to paint and costs bandwidth every time
 * anyone opens the deal. Supabase can resize on the fly, but image
 * transformations are a paid add-on this project does not have — so the resize
 * happens here, in the browser, before the bytes ever leave the machine.
 *
 * Two copies come out: a small one for the tiles and a capped-2000px one for
 * the lightbox. The original is deliberately not kept. These are condition
 * photos for a wholesale contract, not archival scans, and 2000px is more than
 * anyone needs to see a roof line or a cracked slab.
 *
 * EXIF orientation is the trap here. A photo taken in portrait is very often
 * stored landscape with a flag saying "rotate me", and a canvas draw ignores
 * that flag — which is how you end up with a gallery of sideways houses.
 * createImageBitmap with imageOrientation: 'from-image' applies it. The <img>
 * fallback below does not, so it is only ever reached on browsers old enough
 * to lack createImageBitmap, where an <img> element honours the flag itself.
 */

/** Longest edge of the copy shown in the lightbox. */
const FULL_EDGE = 2000;
/** Longest edge of the copy shown in the grid. */
const THUMB_EDGE = 480;

/**
 * Formats a canvas can read. HEIC is missing on purpose: it is what an iPhone
 * hands over by default and no desktop browser decodes it, so it takes the
 * untouched path rather than failing.
 */
const RESIZABLE = /^image\/(jpeg|png|webp)$/i;

/**
 * What the extension says the file is, for the very common case where the
 * browser says nothing at all.
 *
 * A File does not always carry a type. Dragged out of another tab, off the
 * macOS screenshot thumbnail, out of Photos, or picked on a machine with no
 * handler registered for the format, `file.type` is the empty string — and a
 * bucket with an allowed_mime_types list refuses application/octet-stream, so
 * a perfectly ordinary .jpg was being turned away for saying nothing about
 * itself. The name is the only other thing we know, so we use it.
 */
const MIME_BY_EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg',
  png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  heic: 'image/heic', heif: 'image/heif', avif: 'image/avif',
  bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
};

/** True for anything we are willing to treat as a photo of a house. */
export function looksLikeAnImage(file) {
  if (/^image\//i.test(file.type || '')) return true;
  const ext = (file.name?.split('.').pop() || '').toLowerCase();
  return Object.prototype.hasOwnProperty.call(MIME_BY_EXT, ext);
}

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      // Safari has shipped createImageBitmap without the options bag. Retrying
      // bare gets the decode; orientation is then whatever the file says.
      try { return await createImageBitmap(file); } catch { /* fall through */ }
    }
  }
  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
    img.src = url;
  });
}

function scaleTo(source, edge, quality) {
  const w = source.width || source.naturalWidth;
  const h = source.height || source.naturalHeight;
  const ratio = Math.min(1, edge / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * ratio);
  canvas.height = Math.round(h * ratio);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve({ blob, width: canvas.width, height: canvas.height }),
      'image/jpeg', quality);
  });
}

/**
 * @returns {Promise<{full: Blob, thumb: Blob|null, width: number|null,
 *                    height: number|null, mime: string, ext: string}>}
 *
 * `thumb: null` is the honest signal that this file could not be decoded and
 * the caller is holding the original — the grid then shows the full object and
 * the row's thumb_path stays null.
 */
export async function prepareImage(file) {
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  const untouched = {
    full: file,
    thumb: null,
    width: null,
    height: null,
    // The extension outranks an empty type, and outranks octet-stream too:
    // a browser that hands over application/octet-stream for a file named
    // .jpg is guessing worse than we are, and the bucket's allowed_mime_types
    // list refuses that guess outright.
    mime: pickMime(file, ext),
    ext,
  };

  if (!RESIZABLE.test(file.type || '')) return untouched;

  try {
    const bitmap = await decode(file);
    const [full, thumb] = await Promise.all([
      scaleTo(bitmap, FULL_EDGE, 0.84),
      scaleTo(bitmap, THUMB_EDGE, 0.7),
    ]);
    bitmap.close?.();
    if (!full.blob || !thumb.blob) return untouched;
    return {
      full: full.blob,
      thumb: thumb.blob,
      width: full.width,
      height: full.height,
      mime: 'image/jpeg',
      ext: 'jpg',
    };
  } catch {
    // A decode failure is not an upload failure. Send the original.
    return untouched;
  }
}

/**
 * The browser's type when it has one worth having, the extension otherwise.
 */
function pickMime(file, ext) {
  const claimed = (file.type || '').toLowerCase();
  if (claimed.startsWith('image/')) return claimed;
  return MIME_BY_EXT[ext] || claimed || 'application/octet-stream';
}
