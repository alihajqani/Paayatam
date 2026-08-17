import { describe, expect, it } from 'vitest';
import { MAX_UPLOAD_BYTES, sniff, validateUpload } from './upload';

/**
 * The upload validator (T13), and the plan's *"upload rejects a polyglot and an
 * SVG"*.
 *
 * The threat is a browser and an image library disagreeing about what a file is. A
 * **polyglot** is valid in two formats at once — a GIF whose comment block is a
 * `<script>` tag, a JPEG carrying an HTML document after its EOI marker — served
 * with whatever content type the server decided and then sniffed by the browser
 * into something else. An **SVG** is simpler and worse: it is a document, it can
 * carry script, and nothing makes it safe to serve from the product's own origin.
 */

const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A minimal valid PNG header plus an IHDR carrying the given dimensions. */
function png(width = 800, height = 600, trailer = ''): Uint8Array {
  const bytes = new Uint8Array(24 + trailer.length);
  bytes.set(PNG_HEADER, 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  for (let index = 0; index < trailer.length; index += 1) {
    bytes[24 + index] = trailer.charCodeAt(index);
  }
  return bytes;
}

function ascii(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index);
  return bytes;
}

describe('what is accepted', () => {
  it('accepts a PNG', () => {
    expect(validateUpload(png())).toEqual({ ok: true, format: 'png' });
  });

  it('accepts a JPEG', () => {
    const bytes = new Uint8Array(64);
    bytes.set([0xff, 0xd8, 0xff], 0);
    expect(validateUpload(bytes)).toMatchObject({ ok: true, format: 'jpeg' });
  });

  it('accepts a WebP', () => {
    const bytes = new Uint8Array(64);
    bytes.set(ascii('RIFF'), 0);
    bytes.set(ascii('WEBP'), 8);
    expect(validateUpload(bytes)).toMatchObject({ ok: true, format: 'webp' });
  });
});

describe('SVG is rejected by name', () => {
  it.each([
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>',
    '   <svg/>',
  ])('rejects %o', (text) => {
    expect(validateUpload(ascii(text))).toEqual({ ok: false, reason: 'SVG_REJECTED' });
  });

  /**
   * Reported separately from "unknown format" because "we do not accept SVG" is a
   * thing a user can act on, while an unknown-format error for a perfectly valid
   * SVG would look like a bug in the product.
   */
  it('says SVG rather than unknown format', () => {
    const verdict = validateUpload(ascii('<svg/>'));
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe('SVG_REJECTED');
  });
});

describe('polyglots are rejected', () => {
  /**
   * The marker is searched over the **whole** buffer, not just the header — the
   * entire point of a polyglot is that the second format lives somewhere the first
   * format's parser skips.
   */
  it.each([
    ['an HTML document after the image', '<!doctype html><html><body>hi</body></html>'],
    ['a script tag', '<script>alert(document.cookie)</script>'],
    ['an XML preamble', '<?xml version="1.0"?><svg/>'],
    ['PHP', '<?php system($_GET["c"]); ?>'],
  ])('rejects a PNG carrying %s', (_label, trailer) => {
    expect(validateUpload(png(800, 600, trailer))).toEqual({ ok: false, reason: 'POLYGLOT' });
  });

  it('accepts an image whose trailing bytes are ordinary binary', () => {
    expect(validateUpload(png(800, 600, 'IDATrandombinarydata'))).toMatchObject({ ok: true });
  });
});

describe('what else is refused', () => {
  it('refuses an empty file', () => {
    expect(validateUpload(new Uint8Array(0))).toEqual({ ok: false, reason: 'EMPTY' });
  });

  it('refuses anything over the size cap', () => {
    const bytes = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    bytes.set(PNG_HEADER, 0);
    expect(validateUpload(bytes)).toEqual({ ok: false, reason: 'TOO_LARGE' });
  });

  /** A filename and a Content-Type are supplied by the caller; the bytes are not. */
  it('refuses a file that is not an image whatever it claims to be', () => {
    expect(validateUpload(ascii('MZ\x90\x00 this is a windows executable'))).toEqual({
      ok: false,
      reason: 'UNKNOWN_FORMAT',
    });
  });

  it('refuses a RIFF container that is not WebP', () => {
    const bytes = new Uint8Array(64);
    bytes.set(ascii('RIFF'), 0);
    bytes.set(ascii('WAVE'), 8);
    expect(validateUpload(bytes)).toEqual({ ok: false, reason: 'UNKNOWN_FORMAT' });
  });

  /**
   * A decompression bomb: a few kilobytes that expand into gigabytes of pixels the
   * moment anything tries to re-encode them.
   */
  it('refuses absurd dimensions', () => {
    expect(validateUpload(png(50_000, 50_000))).toEqual({
      ok: false,
      reason: 'DIMENSIONS_TOO_LARGE',
    });
  });
});

describe('sniffing', () => {
  it('reads the format from the content, not from a claim', () => {
    expect(sniff(png())).toBe('png');
    expect(sniff(ascii('GIF89a'))).toBeNull();
  });
});
