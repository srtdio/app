import { describe, expect, it } from 'vitest';
import { readImageDimensions, type ImageDimensionsResult } from './image-dimensions';

function b(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

/** Assert a probe succeeded with the exact pixel size. */
function expectSize(result: ImageDimensionsResult, width: number, height: number): void {
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.width).toBe(width);
  expect(result.height).toBe(height);
}

// --- PNG -------------------------------------------------------------------

/** An 8-byte signature + a 13-byte IHDR chunk carrying width/height (BE u32). */
function png(width: number, height: number): Uint8Array {
  return b(
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a, // signature
    0x00,
    0x00,
    0x00,
    0x0d, // chunk length 13
    0x49,
    0x48,
    0x44,
    0x52, // "IHDR"
    (width >>> 24) & 0xff,
    (width >>> 16) & 0xff,
    (width >>> 8) & 0xff,
    width & 0xff,
    (height >>> 24) & 0xff,
    (height >>> 16) & 0xff,
    (height >>> 8) & 0xff,
    height & 0xff,
  );
}

describe('readImageDimensions PNG', () => {
  it('reads width and height from IHDR', () => {
    expectSize(readImageDimensions(png(100, 50), 'image/png'), 100, 50);
  });

  it('fails on a truncated header', () => {
    expect(readImageDimensions(png(100, 50).subarray(0, 20), 'image/png').ok).toBe(false);
  });

  it('fails when the bytes do not match the claimed MIME', () => {
    expect(readImageDimensions(png(100, 50), 'image/jpeg').ok).toBe(false);
  });

  it('fails on a zero dimension', () => {
    expect(readImageDimensions(png(0, 50), 'image/png').ok).toBe(false);
  });
});

// --- GIF -------------------------------------------------------------------

/** "GIF89a" + a logical screen descriptor width/height (LE u16). */
function gif(width: number, height: number): Uint8Array {
  return b(
    0x47,
    0x49,
    0x46,
    0x38,
    0x39,
    0x61, // "GIF89a"
    width & 0xff,
    (width >> 8) & 0xff,
    height & 0xff,
    (height >> 8) & 0xff,
    0x00,
    0x00,
  );
}

describe('readImageDimensions GIF', () => {
  it('reads width and height from the logical screen descriptor', () => {
    expectSize(readImageDimensions(gif(640, 480), 'image/gif'), 640, 480);
  });

  it('fails on a truncated header', () => {
    expect(readImageDimensions(gif(16, 16).subarray(0, 8), 'image/gif').ok).toBe(false);
  });

  it('fails when the bytes do not match the claimed MIME', () => {
    expect(readImageDimensions(gif(16, 16), 'image/png').ok).toBe(false);
  });

  it('fails on a zero dimension', () => {
    expect(readImageDimensions(gif(0, 16), 'image/gif').ok).toBe(false);
  });
});

// --- JPEG ------------------------------------------------------------------

const SOI = [0xff, 0xd8];

/** A minimal SOF0 segment: marker, length, precision, height (BE), width (BE). */
function sof0(width: number, height: number): number[] {
  return [
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ];
}

describe('readImageDimensions JPEG', () => {
  it('reads dimensions from the first SOF0', () => {
    expectSize(readImageDimensions(b(...SOI, ...sof0(800, 600)), 'image/jpeg'), 800, 600);
  });

  it('walks past non-frame segments (APP0, DHT/SOF4) to the real SOF', () => {
    const bytes = b(
      ...SOI,
      0xff,
      0xe0,
      0x00,
      0x04,
      0x00,
      0x00, // APP0, length 4
      0xff,
      0xc4,
      0x00,
      0x04,
      0x00,
      0x00, // DHT (0xC4, not a frame), length 4
      ...sof0(320, 240),
    );
    expectSize(readImageDimensions(bytes, 'image/jpeg'), 320, 240);
  });

  it('fails on a truncated frame header', () => {
    expect(readImageDimensions(b(...SOI, 0xff, 0xc0, 0x00, 0x11, 0x08), 'image/jpeg').ok).toBe(
      false,
    );
  });

  it('fails when the bytes do not match the claimed MIME', () => {
    expect(readImageDimensions(png(10, 10), 'image/jpeg').ok).toBe(false);
  });

  it('fails on a zero dimension', () => {
    expect(readImageDimensions(b(...SOI, ...sof0(0, 600)), 'image/jpeg').ok).toBe(false);
  });

  it('fails when no frame header precedes the scan', () => {
    const bytes = b(...SOI, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xda);
    expect(readImageDimensions(bytes, 'image/jpeg').ok).toBe(false);
  });
});

// --- WebP ------------------------------------------------------------------

/** Wrap a chunk payload in a RIFF/WEBP container with the given FourCC. */
function webp(fourcc: string, payload: number[]): Uint8Array {
  const out: number[] = [
    0x52,
    0x49,
    0x46,
    0x46, // "RIFF"
    0x00,
    0x00,
    0x00,
    0x00, // file size (LE, unvalidated)
    0x57,
    0x45,
    0x42,
    0x50, // "WEBP"
    fourcc.charCodeAt(0),
    fourcc.charCodeAt(1),
    fourcc.charCodeAt(2),
    fourcc.charCodeAt(3),
    0x00,
    0x00,
    0x00,
    0x00, // chunk size (LE, unvalidated)
    ...payload,
  ];
  return Uint8Array.from(out);
}

function vp8(width: number, height: number): Uint8Array {
  return webp('VP8 ', [
    0x00,
    0x00,
    0x00, // frame tag
    0x9d,
    0x01,
    0x2a, // start code
    width & 0xff,
    (width >> 8) & 0x3f,
    height & 0xff,
    (height >> 8) & 0x3f,
  ]);
}

function vp8l(width: number, height: number): Uint8Array {
  const bits = (((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14)) >>> 0;
  return webp('VP8L', [
    0x2f,
    bits & 0xff,
    (bits >>> 8) & 0xff,
    (bits >>> 16) & 0xff,
    (bits >>> 24) & 0xff,
  ]);
}

function vp8x(width: number, height: number): Uint8Array {
  const w1 = width - 1;
  const h1 = height - 1;
  return webp('VP8X', [
    0x00,
    0x00,
    0x00,
    0x00, // flags + reserved
    w1 & 0xff,
    (w1 >> 8) & 0xff,
    (w1 >> 16) & 0xff,
    h1 & 0xff,
    (h1 >> 8) & 0xff,
    (h1 >> 16) & 0xff,
  ]);
}

describe('readImageDimensions WebP', () => {
  it('reads a lossy VP8 chunk', () => {
    expectSize(readImageDimensions(vp8(100, 80), 'image/webp'), 100, 80);
  });

  it('reads a lossless VP8L chunk', () => {
    expectSize(readImageDimensions(vp8l(100, 80), 'image/webp'), 100, 80);
  });

  it('reads an extended VP8X chunk', () => {
    expectSize(readImageDimensions(vp8x(1000, 800), 'image/webp'), 1000, 800);
  });

  it('fails on a truncated container', () => {
    expect(readImageDimensions(vp8(100, 80).subarray(0, 12), 'image/webp').ok).toBe(false);
  });

  it('fails when the bytes do not match the claimed MIME', () => {
    expect(readImageDimensions(png(10, 10), 'image/webp').ok).toBe(false);
  });

  it('fails on an unknown chunk type', () => {
    expect(readImageDimensions(webp('XXXX', [0, 0, 0, 0]), 'image/webp').ok).toBe(false);
  });
});

// --- SVG -------------------------------------------------------------------

function svg(markup: string): Uint8Array {
  return new TextEncoder().encode(markup);
}

describe('readImageDimensions SVG', () => {
  it('reads absolute pixel width/height', () => {
    expectSize(
      readImageDimensions(svg('<svg width="120" height="60"></svg>'), 'image/svg+xml'),
      120,
      60,
    );
  });

  it('accepts an explicit px unit', () => {
    expectSize(
      readImageDimensions(svg('<svg width="120px" height="60px"></svg>'), 'image/svg+xml'),
      120,
      60,
    );
  });

  it('falls back to viewBox when width/height are absent', () => {
    expectSize(
      readImageDimensions(svg('<svg viewBox="0 0 200 100"></svg>'), 'image/svg+xml'),
      200,
      100,
    );
  });

  it('does not confuse stroke-width for the width attribute', () => {
    expectSize(
      readImageDimensions(svg('<svg stroke-width="4" viewBox="0 0 30 40"></svg>'), 'image/svg+xml'),
      30,
      40,
    );
  });

  it('fails when neither absolute size nor viewBox is present', () => {
    expect(
      readImageDimensions(svg('<svg width="100%" height="100%"></svg>'), 'image/svg+xml').ok,
    ).toBe(false);
  });

  it('fails on a zero dimension', () => {
    expect(readImageDimensions(svg('<svg width="0" height="0"></svg>'), 'image/svg+xml').ok).toBe(
      false,
    );
  });

  it('fails when there is no <svg> element', () => {
    expect(readImageDimensions(svg('<html></html>'), 'image/svg+xml').ok).toBe(false);
  });
});

describe('readImageDimensions dispatch', () => {
  it('fails for a MIME type outside the image allowlist', () => {
    expect(readImageDimensions(png(10, 10), 'image/tiff').ok).toBe(false);
    expect(readImageDimensions(png(10, 10), 'application/pdf').ok).toBe(false);
  });
});
