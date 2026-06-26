import { describe, expect, it } from 'vitest';
import { verifyMagicBytes } from './magic-bytes';

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

// An ISO-BMFF header: 4-byte box size, then the "ftyp" box type at offset 4.
const FTYP_HEADER = bytes(0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70);
const EBML_HEADER = bytes(0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00);
const ID3_HEADER = bytes(0x49, 0x44, 0x33, 0x03, 0x00);
const MP3_FRAME_SYNC = bytes(0xff, 0xfb, 0x90, 0x00);

describe('verifyMagicBytes audio types', () => {
  it('accepts audio/mp4 with an ftyp signature', () => {
    expect(verifyMagicBytes(FTYP_HEADER, 'audio/mp4')).toBe(true);
    expect(verifyMagicBytes(FTYP_HEADER, 'audio/mp4; codecs=mp4a')).toBe(true);
  });

  it('rejects audio/mp4 when the ftyp box is absent', () => {
    expect(verifyMagicBytes(EBML_HEADER, 'audio/mp4')).toBe(false);
  });

  it('accepts audio/webm with a Matroska/EBML header', () => {
    expect(verifyMagicBytes(EBML_HEADER, 'audio/webm')).toBe(true);
    expect(verifyMagicBytes(EBML_HEADER, 'audio/webm; codecs=opus')).toBe(true);
  });

  it('rejects audio/webm when the EBML header is absent', () => {
    expect(verifyMagicBytes(FTYP_HEADER, 'audio/webm')).toBe(false);
  });

  it('accepts audio/mpeg with an ID3 tag or a frame sync', () => {
    expect(verifyMagicBytes(ID3_HEADER, 'audio/mpeg')).toBe(true);
    expect(verifyMagicBytes(MP3_FRAME_SYNC, 'audio/mpeg')).toBe(true);
  });

  it('rejects audio/mpeg on a bare 0xff without a valid sync byte', () => {
    expect(verifyMagicBytes(bytes(0xff, 0x00, 0x00), 'audio/mpeg')).toBe(false);
    expect(verifyMagicBytes(EBML_HEADER, 'audio/mpeg')).toBe(false);
  });
});

describe('verifyMagicBytes existing types are unaffected', () => {
  it('still verifies png and pdf', () => {
    expect(verifyMagicBytes(bytes(0x89, 0x50, 0x4e, 0x47), 'image/png')).toBe(true);
    expect(verifyMagicBytes(bytes(0x25, 0x50, 0x44, 0x46), 'application/pdf')).toBe(true);
  });

  it('still verifies video/mp4 via ftyp', () => {
    expect(verifyMagicBytes(FTYP_HEADER, 'video/mp4')).toBe(true);
  });
});
