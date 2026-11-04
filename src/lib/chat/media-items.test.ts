import { describe, expect, it } from 'vitest';
import { APP_ENTITY_ROUTES } from '@/lib/chat/message-links';
import type { SearchHit } from '@/lib/chat/search';
import {
  flattenHits,
  flattenLinks,
  flattenMedia,
  formatDurationMs,
  groupByMonth,
  isMediaCacheValue,
  mediaCacheWhat,
  monthGroupOf,
  THIS_WEEK_LABEL,
} from '@/lib/chat/media-items';

function hit(id: string, over: Partial<SearchHit> = {}): SearchHit {
  return {
    id,
    channelId: 'c1',
    senderUserId: 'u1',
    body: '',
    createdAt: '2026-11-03T10:00:00Z',
    ...over,
  };
}

const NOW = Date.parse('2026-11-04T12:00:00Z');
const UTC = 'UTC';

describe('flattenMedia', () => {
  it('turns a 3-photo message into 3 tiles, in attachment order', () => {
    const h = hit('m1', {
      attachmentAssetIds: ['a', 'b', 'c'],
      attachmentMeta: {
        a: { mime: 'image/jpeg', name: 'a.jpg', size: 10 },
        b: { mime: 'image/png', name: 'b.png', size: 20 },
        c: { mime: 'image/jpeg', name: 'c.jpg', size: 30, width: 800, height: 600 },
      },
    });
    const items = flattenMedia([h], 'photo');
    expect(items.map((i) => i.key)).toEqual(['m1:a', 'm1:b', 'm1:c']);
    expect(items[2]).toMatchObject({ width: 800, height: 600, size: 30, channelId: 'c1' });
  });

  it('lists a video only under video, with its duration', () => {
    const h = hit('m2', {
      attachmentAssetIds: ['p', 'v'],
      attachmentMeta: {
        p: { mime: 'image/jpeg', name: 'p.jpg', size: 1 },
        v: { mime: 'video/mp4', name: 'v.mp4', size: 2, duration_ms: 12_000 },
      },
    });
    expect(flattenMedia([h], 'photo').map((i) => i.versionId)).toEqual(['p']);
    const videos = flattenMedia([h], 'video');
    expect(videos.map((i) => i.versionId)).toEqual(['v']);
    expect(videos[0]?.durationMs).toBe(12_000);
    expect(flattenMedia([h], 'file')).toEqual([]);
  });

  it('keeps file page counts and voice notes apart', () => {
    const h = hit('m3', {
      attachmentAssetIds: ['d', 'n'],
      attachmentMeta: {
        d: { mime: 'application/pdf', name: 'd.pdf', size: 9, page_count: 4, thumb_w: 580, thumb_h: 820 },
        n: { mime: 'audio/webm', name: 'n.webm', size: 3, duration_ms: 5000 },
      },
    });
    expect(flattenMedia([h], 'file')[0]).toMatchObject({ pageCount: 4, thumbW: 580, thumbH: 820 });
    expect(flattenMedia([h], 'voice')[0]).toMatchObject({ versionId: 'n', durationMs: 5000 });
  });

  it('skips files removed from the row and those behind the Undo window', () => {
    // A sender's removal rewrites attachment_asset_ids; removed_files holds only counts.
    const h = hit('m4', {
      attachmentAssetIds: ['keep', 'undo'],
      attachmentMeta: {
        keep: { mime: 'image/jpeg', name: 'k', size: 1 },
        undo: { mime: 'image/jpeg', name: 'u', size: 1 },
        gone: { mime: 'image/jpeg', name: 'g', size: 1 },
      },
    });
    const items = flattenMedia([h], 'photo', (_c, m, v) => m === 'm4' && v === 'undo');
    expect(items.map((i) => i.versionId)).toEqual(['keep']);
  });
});

describe('flattenLinks', () => {
  it('turns a message with 2 links into 2 rows', () => {
    const h = hit('m5', { body: 'see https://a.example/x and https://b.example/y' });
    const rows = flattenLinks([h], 'https://srtd.io', APP_ENTITY_ROUTES);
    expect(rows.map((r) => [r.key, r.url])).toEqual([
      ['m5:0', 'https://a.example/x'],
      ['m5:1', 'https://b.example/y'],
    ]);
    expect(flattenHits([h], 'link', { appOrigin: null, routes: APP_ENTITY_ROUTES })).toHaveLength(2);
  });
});

describe('groupByMonth', () => {
  it('labels this week, months of this year, and months of other years', () => {
    const items = [
      { createdAt: '2026-11-03T10:00:00Z' },
      { createdAt: '2026-11-01T10:00:00Z' },
      { createdAt: '2026-10-20T10:00:00Z' },
      { createdAt: '2026-10-02T10:00:00Z' },
      { createdAt: '2025-09-10T10:00:00Z' },
    ];
    const groups = groupByMonth(items, NOW, UTC);
    expect(groups.map((g) => [g.label, g.items.length])).toEqual([
      [THIS_WEEK_LABEL, 2],
      ['October', 2],
      ['September 2025', 1],
    ]);
  });

  it('keys a month by YYYY-MM', () => {
    expect(monthGroupOf('2026-03-15T10:00:00Z', NOW, UTC)).toEqual({ key: '2026-03', label: 'March' });
  });
});

describe('cache helpers', () => {
  it('names the device-cache key per chip and checks the saved shape', () => {
    expect(mediaCacheWhat('video')).toBe('chat:media:video');
    expect(isMediaCacheValue({ kind: 'photo', items: [] }, 'photo')).toBe(true);
    expect(isMediaCacheValue({ kind: 'photo', items: [] }, 'video')).toBe(false);
    expect(isMediaCacheValue(null, 'photo')).toBe(false);
  });

  it('formats durations', () => {
    expect(formatDurationMs(12_000)).toBe('0:12');
    expect(formatDurationMs(245_000)).toBe('4:05');
    expect(formatDurationMs(3_723_000)).toBe('1:02:03');
  });
});
