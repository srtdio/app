import { describe, expect, it } from 'vitest';
import {
  LIST_COPY_MAX_HEIGHT,
  LIST_COPY_MAX_WIDTH,
  listCopyBox,
  parseThumbnailMode,
} from '../../packages/etl/src/backfill-image-thumbnails';

describe('backfill-image-thumbnails: mode', () => {
  it('defaults to dry-run and accepts apply', () => {
    expect(parseThumbnailMode([])).toBe('dry-run');
    expect(parseThumbnailMode(['--mode=apply'])).toBe('apply');
    expect(parseThumbnailMode(['--', '--apply'])).toBe('apply');
  });
  it('aborts on an unknown flag', () => {
    expect(() => parseThumbnailMode(['--force'])).toThrow(/Unknown flag/);
  });
});

describe('backfill-image-thumbnails: list copy size', () => {
  it('fits 320 x 1160 and never upscales, matching the upload-time copy', () => {
    expect(listCopyBox(1080, 1350)).toEqual({ width: LIST_COPY_MAX_WIDTH, height: 400 });
    expect(listCopyBox(200, 100)).toEqual({ width: 200, height: 100 });
    expect(listCopyBox(1000, 8000)).toEqual({ width: 145, height: LIST_COPY_MAX_HEIGHT });
  });
});
