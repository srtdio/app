import { describe, expect, it } from 'vitest';
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
  it('every platform offers only known formats', () => {
    for (const p of POST_PLATFORMS) {
      for (const f of FORMATS_BY_PLATFORM[p]) expect(POST_FORMATS).toContain(f);
    }
  });
});
