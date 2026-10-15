import { describe, expect, it } from 'vitest';
import { PostSchema } from '@srtdio/schemas';
import { FORMATS_BY_PLATFORM, POST_FORMATS, POST_PLATFORMS } from './create';

describe('platform / format single source', () => {
  it('lists all 7 platforms', () => {
    expect(POST_PLATFORMS).toEqual([
      'instagram',
      'x',
      'threads',
      'linkedin',
      'facebook',
      'tiktok',
      'youtube_shorts',
    ]);
  });
  it('the zod post platform enum has all 7 platforms', () => {
    const zodPlatforms = PostSchema.shape.platform.options;
    expect(zodPlatforms).toHaveLength(7);
    expect([...zodPlatforms].sort()).toEqual([...POST_PLATFORMS].sort());
  });
  it('the zod post format enum matches POST_FORMATS', () => {
    expect([...PostSchema.shape.format.options].sort()).toEqual([...POST_FORMATS].sort());
  });
  it('every platform offers only known formats', () => {
    for (const p of POST_PLATFORMS) {
      for (const f of FORMATS_BY_PLATFORM[p]) expect(POST_FORMATS).toContain(f);
    }
  });
});
