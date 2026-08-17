/**
 * What an uploaded image must be before anything else touches it (T13).
 *
 * **This is the validator, not an upload endpoint.** `media` does not exist yet —
 * M3 and M4 both deferred `avatar_media_id` and `image_media_id` because "a column
 * with no foreign key is an invitation to write an unvalidated id into it" — so
 * there is nothing to store against. What is built here is the part that decides
 * whether bytes are acceptable, because that decision is the security control and
 * it is worth having tested and ready before the plumbing that calls it exists.
 *
 * The threat is specific. A browser and an image library disagree about what a
 * file is: a **polyglot** is valid in two formats at once — a GIF whose comment
 * block is a `<script>` tag, a JPEG carrying an HTML document after its EOI marker
 * — and it is served with whatever content type the *server* decided, then
 * sniffed by the *browser* into something else. An SVG is worse and simpler: it is
 * a document, it can carry script, and no amount of sniffing makes it safe to
 * serve from the product's own origin.
 */

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_DIMENSION = 4096;

export type ImageFormat = 'jpeg' | 'png' | 'webp';

export type UploadRejection =
  | 'EMPTY'
  | 'TOO_LARGE'
  | 'UNKNOWN_FORMAT'
  /** SVG is rejected by name, however well-formed (T13). */
  | 'SVG_REJECTED'
  /** Valid in two formats at once, or carrying a document after the image ends. */
  | 'POLYGLOT'
  | 'DIMENSIONS_TOO_LARGE';

export type UploadVerdict =
  { ok: true; format: ImageFormat } | { ok: false; reason: UploadRejection };

/**
 * Magic bytes for the three formats that are allowed.
 *
 * An **allowlist**, sniffed from the content rather than trusted from a filename
 * or a `Content-Type` header — both are supplied by the caller, and a caller
 * uploading a malicious file is not going to label it honestly.
 */
const SIGNATURES: ReadonlyArray<{ format: ImageFormat; magic: readonly number[] }> = [
  { format: 'jpeg', magic: [0xff, 0xd8, 0xff] },
  { format: 'png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  // WebP is RIFF....WEBP — the four bytes at offset 8 are checked separately.
  { format: 'webp', magic: [0x52, 0x49, 0x46, 0x46] },
];

/**
 * Markers that make a file a document as well as an image.
 *
 * Searched over the **whole** buffer, not just the header, because the entire
 * point of a polyglot is that the second format lives somewhere the first format's
 * parser skips — a comment block, a trailing chunk, the space after an EOI marker.
 */
const DOCUMENT_MARKERS: readonly string[] = [
  '<?xml',
  '<svg',
  '<!doctype html',
  '<html',
  '<script',
  '<?php',
];

/**
 * Whether these bytes may be stored.
 *
 * Order matters: cheap structural checks first, so a 40 MB upload is refused on
 * its size rather than after a full scan.
 */
export function validateUpload(bytes: Uint8Array): UploadVerdict {
  if (bytes.byteLength === 0) return { ok: false, reason: 'EMPTY' };
  if (bytes.byteLength > MAX_UPLOAD_BYTES) return { ok: false, reason: 'TOO_LARGE' };

  // SVG is checked before the signature sniff and reported separately, because
  // "we do not accept SVG" is a thing a user can act on, while "unknown format"
  // for a perfectly valid SVG would look like a bug in the product.
  const head = decodeAscii(bytes.subarray(0, 1024)).toLowerCase().trimStart();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) {
    return { ok: false, reason: 'SVG_REJECTED' };
  }

  const format = sniff(bytes);
  if (format === null) return { ok: false, reason: 'UNKNOWN_FORMAT' };

  if (containsDocumentMarker(bytes)) return { ok: false, reason: 'POLYGLOT' };

  const dimensions = readDimensions(bytes, format);
  if (
    dimensions !== null &&
    (dimensions.width > MAX_DIMENSION || dimensions.height > MAX_DIMENSION)
  ) {
    // A decompression bomb: a few kilobytes that expand into gigabytes of pixels
    // the moment anything tries to re-encode them.
    return { ok: false, reason: 'DIMENSIONS_TOO_LARGE' };
  }

  return { ok: true, format };
}

/** The format these bytes actually are, from their content alone. */
export function sniff(bytes: Uint8Array): ImageFormat | null {
  for (const { format, magic } of SIGNATURES) {
    if (magic.every((byte, index) => bytes[index] === byte)) {
      if (format !== 'webp') return format;
      // RIFF is a container. Only the WEBP flavour of it is an image we accept.
      return decodeAscii(bytes.subarray(8, 12)) === 'WEBP' ? 'webp' : null;
    }
  }
  return null;
}

function containsDocumentMarker(bytes: Uint8Array): boolean {
  const text = decodeAscii(bytes).toLowerCase();
  return DOCUMENT_MARKERS.some((marker) => text.includes(marker));
}

/**
 * Width and height, for the two formats where they are cheap to read.
 *
 * Returns null rather than guessing for anything else — a wrong dimension would
 * reject a legitimate image, and the re-encode step (which T13 also requires, and
 * which needs `sharp` and therefore the upload pipeline that does not exist yet)
 * is where the real bound belongs.
 */
export function readDimensions(
  bytes: Uint8Array,
  format: ImageFormat,
): { width: number; height: number } | null {
  if (format === 'png' && bytes.byteLength >= 24) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }

  if (format === 'jpeg') {
    // Walk the segment markers to SOF, which is where the dimensions live.
    let offset = 2;
    while (offset + 9 < bytes.byteLength) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1] ?? 0;
      // SOF0–SOF3 and SOF5–SOF7: the frame headers that carry dimensions.
      if (marker >= 0xc0 && marker <= 0xc7 && marker !== 0xc4) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
      }
      const length = ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0);
      if (length <= 0) break;
      offset += 2 + length;
    }
  }

  return null;
}

function decodeAscii(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}
