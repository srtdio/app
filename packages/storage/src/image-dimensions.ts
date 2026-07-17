// Intrinsic pixel dimensions from image bytes, dependency-free.
//
// The asset pipeline runs inside a Cloudflare Worker (no native modules, no
// sharp), so dimensions are read by parsing only the bytes each format needs to
// declare its size: PNG's IHDR, JPEG's SOF frame header, GIF's logical screen
// descriptor, the three WebP chunk layouts, and SVG's width/height/viewBox.
//
// Truncated, corrupt, or mismatched bytes are an EXPECTED outcome, not a fault:
// this never throws and never returns null. Every call resolves to a
// discriminated Result so the caller decides what a miss means (the pipeline
// stores null width/height and logs a warning). @srtdio/storage has no shared
// Result type, so a minimal one is defined here rather than imported.

/**
 * The outcome of a dimension probe. `ok: true` carries concrete positive pixel
 * dimensions; `ok: false` carries a short machine-readable reason describing why
 * no size could be read (unsupported type, bad signature, truncation, zero size).
 */
export type ImageDimensionsResult =
  | { ok: true; width: number; height: number }
  | { ok: false; reason: string };

function ok(width: number, height: number): ImageDimensionsResult {
  return { ok: true, width, height };
}

function fail(reason: string): ImageDimensionsResult {
  return { ok: false, reason };
}

function readU16BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] as number) << 8) | (bytes[offset + 1] as number);
}

function readU32BE(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] as number) << 24) |
      ((bytes[offset + 1] as number) << 16) |
      ((bytes[offset + 2] as number) << 8) |
      (bytes[offset + 3] as number)) >>>
    0
  );
}

function readU16LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] as number) | ((bytes[offset + 1] as number) << 8);
}

function readU24LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] as number) |
    ((bytes[offset + 1] as number) << 8) |
    ((bytes[offset + 2] as number) << 16)
  );
}

/** True when `bytes` carries the ASCII `text` starting at `offset`. */
function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.length < offset + text.length) {
    return false;
  }
  for (let i = 0; i < text.length; i += 1) {
    if (bytes[offset + i] !== text.charCodeAt(i)) {
      return false;
    }
  }
  return true;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** PNG: the 8-byte signature, then an IHDR chunk whose width/height are the
 * first two big-endian u32s of its data (bytes 16..24). */
function readPng(bytes: Uint8Array): ImageDimensionsResult {
  if (bytes.length < 24) {
    return fail('png: truncated header');
  }
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) {
      return fail('png: bad signature');
    }
  }
  if (!asciiAt(bytes, 12, 'IHDR')) {
    return fail('png: missing IHDR');
  }
  const width = readU32BE(bytes, 16);
  const height = readU32BE(bytes, 20);
  if (width === 0 || height === 0) {
    return fail('png: zero dimension');
  }
  return ok(width, height);
}

/** GIF: "GIF87a"/"GIF89a" then a little-endian u16 width and height in the
 * logical screen descriptor (bytes 6..10). */
function readGif(bytes: Uint8Array): ImageDimensionsResult {
  if (bytes.length < 10) {
    return fail('gif: truncated header');
  }
  if (!asciiAt(bytes, 0, 'GIF87a') && !asciiAt(bytes, 0, 'GIF89a')) {
    return fail('gif: bad signature');
  }
  const width = readU16LE(bytes, 6);
  const height = readU16LE(bytes, 8);
  if (width === 0 || height === 0) {
    return fail('gif: zero dimension');
  }
  return ok(width, height);
}

/** A JPEG start-of-frame marker (SOF0..SOF15) carries the frame dimensions.
 * 0xC4 (DHT), 0xC8 (JPG) and 0xCC (DAC) share the range but are not frames. */
function isSofMarker(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/** JPEG: walk the marker stream from SOI to the first real SOF, whose segment
 * data is precision(1), height(u16 BE), width(u16 BE). */
function readJpeg(bytes: Uint8Array): ImageDimensionsResult {
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return fail('jpeg: bad signature');
  }
  let offset = 2;
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      return fail('jpeg: lost marker alignment');
    }
    let marker = bytes[offset + 1] as number;
    // Any number of 0xff fill bytes may precede the marker id.
    while (marker === 0xff && offset + 2 < bytes.length) {
      offset += 1;
      marker = bytes[offset + 1] as number;
    }
    // SOS begins entropy-coded data and EOI ends the image: neither yields a
    // frame header we have not already passed, so stop looking.
    if (marker === 0xda || marker === 0xd9) {
      return fail('jpeg: no frame header before scan');
    }
    // Standalone markers (RSTn, TEM, SOI) carry no length-prefixed payload.
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xd8) {
      offset += 2;
      continue;
    }
    if (offset + 3 >= bytes.length) {
      return fail('jpeg: truncated segment length');
    }
    const segLen = readU16BE(bytes, offset + 2);
    if (isSofMarker(marker)) {
      // Need precision (offset+4) plus height (offset+5..6) and width (offset+7..8).
      if (offset + 8 >= bytes.length) {
        return fail('jpeg: truncated frame header');
      }
      const height = readU16BE(bytes, offset + 5);
      const width = readU16BE(bytes, offset + 7);
      if (width === 0 || height === 0) {
        return fail('jpeg: zero dimension');
      }
      return ok(width, height);
    }
    if (segLen < 2) {
      return fail('jpeg: invalid segment length');
    }
    offset += 2 + segLen;
  }
  return fail('jpeg: no frame header');
}

/** VP8 (lossy): after the RIFF/WEBP header and the "VP8 " chunk header, a 3-byte
 * frame tag, the start code 0x9d 0x01 0x2a, then 14-bit width and height. */
function readVp8(bytes: Uint8Array): ImageDimensionsResult {
  if (bytes.length < 30) {
    return fail('webp/vp8: truncated header');
  }
  if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
    return fail('webp/vp8: bad start code');
  }
  const width = readU16LE(bytes, 26) & 0x3fff;
  const height = readU16LE(bytes, 28) & 0x3fff;
  if (width === 0 || height === 0) {
    return fail('webp/vp8: zero dimension');
  }
  return ok(width, height);
}

/** VP8L (lossless): a 0x2f signature byte then 14-bit (width-1) and 14-bit
 * (height-1) packed little-endian across the next four bytes. */
function readVp8l(bytes: Uint8Array): ImageDimensionsResult {
  if (bytes.length < 25) {
    return fail('webp/vp8l: truncated header');
  }
  if (bytes[20] !== 0x2f) {
    return fail('webp/vp8l: bad signature');
  }
  const bits =
    ((bytes[21] as number) |
      ((bytes[22] as number) << 8) |
      ((bytes[23] as number) << 16) |
      ((bytes[24] as number) << 24)) >>>
    0;
  const width = (bits & 0x3fff) + 1;
  const height = ((bits >>> 14) & 0x3fff) + 1;
  return ok(width, height);
}

/** VP8X (extended): a flags byte, 3 reserved bytes, then 24-bit (canvas-width-1)
 * and 24-bit (canvas-height-1), all little-endian. */
function readVp8x(bytes: Uint8Array): ImageDimensionsResult {
  if (bytes.length < 30) {
    return fail('webp/vp8x: truncated header');
  }
  const width = readU24LE(bytes, 24) + 1;
  const height = readU24LE(bytes, 27) + 1;
  return ok(width, height);
}

/** WebP: a RIFF/WEBP container whose first chunk FourCC selects the layout. */
function readWebp(bytes: Uint8Array): ImageDimensionsResult {
  if (bytes.length < 16 || !asciiAt(bytes, 0, 'RIFF') || !asciiAt(bytes, 8, 'WEBP')) {
    return fail('webp: bad signature');
  }
  if (asciiAt(bytes, 12, 'VP8 ')) {
    return readVp8(bytes);
  }
  if (asciiAt(bytes, 12, 'VP8L')) {
    return readVp8l(bytes);
  }
  if (asciiAt(bytes, 12, 'VP8X')) {
    return readVp8x(bytes);
  }
  return fail('webp: unknown chunk type');
}

const svgDecoder = new TextDecoder('utf-8', { fatal: false });

/** Parse an attribute value from an opening tag. The name is anchored to a
 * preceding whitespace char so `width` never matches inside `stroke-width`. */
function attrValue(tag: string, name: string): string | null {
  const re = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i');
  const m = re.exec(tag);
  if (!m) {
    return null;
  }
  return (m[2] ?? m[3] ?? '').trim();
}

/** A length is an absolute pixel value only when it is a bare number or one with
 * an explicit `px` unit; %, em, and other units are not concrete pixel sizes. */
function absolutePx(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const m = /^([0-9]*\.?[0-9]+)(px)?$/i.exec(value);
  if (!m) {
    return null;
  }
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** SVG: prefer absolute pixel width/height on the root tag; fall back to the
 * viewBox width/height. Neither yielding a concrete size is an expected miss. */
function readSvg(bytes: Uint8Array): ImageDimensionsResult {
  const text = svgDecoder.decode(bytes);
  const tagMatch = /<svg\b[^>]*>/i.exec(text);
  if (!tagMatch) {
    return fail('svg: no <svg> element');
  }
  const tag = tagMatch[0];

  const width = absolutePx(attrValue(tag, 'width'));
  const height = absolutePx(attrValue(tag, 'height'));
  if (width !== null && height !== null) {
    if (width <= 0 || height <= 0) {
      return fail('svg: zero dimension');
    }
    return ok(Math.round(width), Math.round(height));
  }

  const viewBox = attrValue(tag, 'viewBox');
  if (viewBox !== null) {
    const parts = viewBox.split(/[\s,]+/).filter((p) => p !== '');
    if (parts.length === 4) {
      const vw = Number(parts[2]);
      const vh = Number(parts[3]);
      if (Number.isFinite(vw) && Number.isFinite(vh) && vw > 0 && vh > 0) {
        return ok(Math.round(vw), Math.round(vh));
      }
    }
  }
  return fail('svg: no absolute width/height or viewBox');
}

/**
 * Read intrinsic pixel dimensions from `bytes`, dispatched on the normalized
 * image MIME type. Supports exactly the pipeline's image allowlist
 * (jpeg/png/webp/gif/svg+xml). Any other type, or bytes that do not match the
 * claimed type, resolves to `{ ok: false }` - never a throw, never null.
 */
export function readImageDimensions(bytes: Uint8Array, mimeType: string): ImageDimensionsResult {
  switch (mimeType) {
    case 'image/png':
      return readPng(bytes);
    case 'image/jpeg':
      return readJpeg(bytes);
    case 'image/gif':
      return readGif(bytes);
    case 'image/webp':
      return readWebp(bytes);
    case 'image/svg+xml':
      return readSvg(bytes);
    default:
      return fail(`unsupported mime for dimensions: ${mimeType}`);
  }
}
