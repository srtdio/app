import { describe, expect, it } from 'vitest';
import { ALLOWED_MIME_TYPES, isAllowedMime, normalizeMime } from './mime';

describe('ALLOWED_MIME_TYPES', () => {
  it('accepts recorded voice-note audio types', () => {
    expect(isAllowedMime('audio/mp4')).toBe(true);
    expect(isAllowedMime('audio/webm')).toBe(true);
    expect(isAllowedMime('audio/mpeg')).toBe(true);
  });

  it('accepts audio types with parameters via normalization', () => {
    expect(isAllowedMime('audio/webm; codecs=opus')).toBe(true);
    expect(normalizeMime('audio/mpeg; charset=binary')).toBe('audio/mpeg');
  });

  it('still rejects unrelated audio types', () => {
    expect(isAllowedMime('audio/ogg')).toBe(false);
    expect(isAllowedMime('audio/wav')).toBe(false);
  });

  it('keeps the existing entries and contains no duplicates', () => {
    expect(ALLOWED_MIME_TYPES).toContain('image/jpeg');
    expect(ALLOWED_MIME_TYPES).toContain('video/mp4');
    expect(ALLOWED_MIME_TYPES).toContain('application/pdf');
    expect(new Set(ALLOWED_MIME_TYPES).size).toBe(ALLOWED_MIME_TYPES.length);
  });
});
