import { describe, expect, it, vi } from 'vitest';
import { PresignCache, type PresignedUrl, type ThumbnailUrlStore } from '@/lib/asset-presign';
import { parseEntries } from '@/lib/local-cache';

const isNumber = (value: unknown): value is number => typeof value === 'number';

describe('parseEntries', () => {
  it('keeps well-formed pairs and drops the rest', () => {
    expect(parseEntries(JSON.stringify([['a', 1], ['b', 'x'], ['c'], 5]), isNumber)).toEqual([
      ['a', 1],
    ]);
  });
  it('treats missing or corrupt storage as an empty cache', () => {
    expect(parseEntries(null, isNumber)).toEqual([]);
    expect(parseEntries('{not json', isNumber)).toEqual([]);
    expect(parseEntries('{"a":1}', isNumber)).toEqual([]);
  });
});

describe('PresignCache with a thumbnail URL store', () => {
  const deps = {
    endpoint: 'https://read.example',
    getAccessToken: async () => 't',
    fetcher: vi.fn(),
  };

  it('paints a still-valid stored URL at once and never asks the network for it', async () => {
    const fresh: PresignedUrl = {
      url: 'https://r2.example/t.jpg',
      expiresAt: Date.now() + 3_600_000,
    };
    const stale: PresignedUrl = {
      url: 'https://r2.example/old.jpg',
      expiresAt: Date.now() + 1_000,
    };
    const store: ThumbnailUrlStore = {
      load: () => [
        ['v-1', fresh],
        ['v-2', stale],
      ],
      save: vi.fn(),
    };
    const cache = new PresignCache(deps, undefined, undefined, store);
    expect(cache.peekThumbnail('v-1')).toEqual(fresh);
    expect(cache.peekThumbnail('v-2')).toBeNull();
    await expect(cache.thumbnail('v-1')).resolves.toEqual(fresh);
    expect(deps.fetcher).not.toHaveBeenCalled();
  });

  it('saves each newly signed thumbnail URL', async () => {
    const body = {
      url: 'https://r2.example/n.jpg',
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    };
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    const save = vi.fn();
    const cache = new PresignCache({ ...deps, fetcher }, undefined, undefined, {
      load: () => [],
      save,
    });
    await cache.thumbnail('v-3');
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0]).toEqual([['v-3', expect.objectContaining({ url: body.url })]]);
  });
});
