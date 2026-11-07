import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@srtdio/rpc';

// The chat store's import graph can reach the agora-chat browser SDK; mock it
// so importing the module in node never touches browser globals.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

// The device cache queues IndexedDB writes; keep them out of the node run.
vi.mock('@/lib/device-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/device-cache')>();
  return { ...actual, put: vi.fn() };
});

import { APP_ENTITY_ROUTES } from '@/lib/chat/message-links';
import {
  flattenHits,
  flattenLinks,
  flattenMedia,
  mediaCacheWhat,
  type MediaCacheValue,
} from '@/lib/chat/media-items';
import {
  isMediaGone,
  markMediaGone,
  resetMediaGone,
  subscribeMediaGone,
  withoutGone,
} from '@/lib/chat/media-gone';
import { dropFromMediaCaches, mediaMessagesGone } from '@/lib/chat/media-cache-drop';
import { toAttachmentItems, toLinkItems } from '@/lib/chat/channel-media';
import {
  createSearchRunner,
  type SearchHit,
  type SearchPageFetch,
  type SearchResult,
} from '@/lib/chat/search';
import { hideLocal, hideMessages, resetHides } from '@/lib/chat/hides';
import { peekKept, primeRead, readKey } from '@/lib/session-read';

const USER = 'u1';
const WS = 'ws-1';

function photoHit(id: string): SearchHit {
  return {
    id,
    channelId: 'c1',
    senderUserId: 'u2',
    body: '',
    createdAt: '2026-11-03T10:00:00Z',
    attachmentAssetIds: [`${id}-a`],
    attachmentMeta: { [`${id}-a`]: { mime: 'image/jpeg', name: `${id}.jpg`, size: 10 } },
  };
}

function linkHit(id: string): SearchHit {
  return {
    id,
    channelId: 'c1',
    senderUserId: 'u2',
    body: `see https://example.com/${id}`,
    createdAt: '2026-11-03T10:00:00Z',
  };
}

const opts = { appOrigin: null, routes: APP_ENTITY_ROUTES };

afterEach(() => {
  resetMediaGone();
  resetHides();
});

describe('media-gone store', () => {
  it('marks ids once, notifies only on a new id, and filters with one lookup', () => {
    const heard = vi.fn();
    const off = subscribeMediaGone(heard);
    expect(markMediaGone(['m1', 'm2'])).toBe(true);
    expect(markMediaGone(['m1'])).toBe(false);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(isMediaGone('m1')).toBe(true);
    expect(isMediaGone('m3')).toBe(false);
    const items = [{ id: 'm1' }, { id: 'm3' }];
    expect(withoutGone(items, (i) => i.id)).toEqual([{ id: 'm3' }]);
    const none = [{ id: 'm9' }];
    expect(withoutGone(none, (i) => i.id)).toBe(none);
    off();
  });
});

describe('D7: deleted messages never flatten to chip items', () => {
  it('a message deleted for everyone lists no photo, link or chat info item', () => {
    const hits = [photoHit('keep'), photoHit('gone')];
    expect(flattenMedia(hits, 'photo').map((i) => i.messageId)).toEqual(['keep', 'gone']);
    // Delete for everyone (the open thread's reportDeleted path).
    mediaMessagesGone({ userId: USER, workspaceId: WS, messageIds: ['gone'] });
    expect(flattenMedia(hits, 'photo').map((i) => i.messageId)).toEqual(['keep']);
    expect(flattenHits(hits, 'photo', opts).map((i) => i.messageId)).toEqual(['keep']);
    expect(
      flattenLinks([linkHit('keep'), linkHit('gone')], null, APP_ENTITY_ROUTES).map(
        (i) => i.messageId,
      ),
    ).toEqual(['keep']);
    // The chat info tabs skip it too.
    const row = (id: string) => ({
      id,
      sender_user_id: 'u2',
      created_at: '2026-11-03T10:00:00Z',
      body: `https://example.com/${id}`,
      attachment_asset_ids: [`${id}-a`],
      attachment_meta: { [`${id}-a`]: { mime: 'image/jpeg', name: 'x.jpg', size: 1 } },
    });
    expect(toAttachmentItems([row('keep'), row('gone')]).map((i) => i.messageId)).toEqual(['keep']);
    expect(
      toLinkItems([row('keep'), row('gone')], null, APP_ENTITY_ROUTES).map((i) => i.messageId),
    ).toEqual(['keep']);
  });

  it('the cached first page drops a deleted message at once (every chip)', () => {
    const photoKey = readKey(USER, WS, mediaCacheWhat('photo'));
    const linkKey = readKey(USER, WS, mediaCacheWhat('link'));
    primeRead<MediaCacheValue>(photoKey, {
      kind: 'photo',
      items: flattenHits([photoHit('keep'), photoHit('gone')], 'photo', opts),
    });
    primeRead<MediaCacheValue>(linkKey, {
      kind: 'link',
      items: flattenHits([linkHit('gone')], 'link', opts),
    });
    mediaMessagesGone({ userId: USER, workspaceId: WS, messageIds: ['gone'] });
    const photos = peekKept<MediaCacheValue>(photoKey);
    expect(photos?.items.map((i) => i.messageId)).toEqual(['keep']);
    expect(peekKept<MediaCacheValue>(linkKey)?.items).toEqual([]);
  });

  it('dropFromMediaCaches leaves a page without the ids untouched', () => {
    const key = readKey(USER, WS, mediaCacheWhat('file'));
    const value: MediaCacheValue = { kind: 'file', items: [] };
    primeRead<MediaCacheValue>(key, value);
    dropFromMediaCaches(USER, WS, ['other']);
    expect(peekKept<MediaCacheValue>(key)).toBe(value);
  });

  it('the search runner drops a gone hit from what it holds and re-emits', async () => {
    let answer: (r: SearchResult) => void = () => undefined;
    const fetch: SearchPageFetch = () => new Promise((resolve) => (answer = resolve));
    const timers: Array<() => void> = [];
    const states: Array<ReturnType<ReturnType<typeof createSearchRunner>['getState']>> = [];
    const runner = createSearchRunner({
      fetch,
      onChange: (s) => states.push(s),
      setTimer: (run) => timers.push(run),
      clearTimer: () => undefined,
    });
    runner.setQuery('', 'photo');
    for (const run of timers.splice(0)) run();
    answer({ ok: true, data: { hits: [photoHit('keep'), photoHit('gone')], next: null } });
    await Promise.resolve();
    await Promise.resolve();
    expect(runner.getState().hits.map((h) => h.id)).toEqual(['keep', 'gone']);
    const before = states.length;
    markMediaGone(['gone']);
    expect(states.length).toBe(before + 1);
    expect(runner.getState().hits.map((h) => h.id)).toEqual(['keep']);
    runner.dispose();
    markMediaGone(['keep']);
    expect(states.length).toBe(before + 1);
  });
});

describe('D7: hidden for me', () => {
  function okClient(): Client {
    return {
      rpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
    } as unknown as Client;
  }

  it('inside the Undo window the item stays in the lists (MediaResults filters it at render)', () => {
    hideLocal(WS, [{ messageId: 'hid', channelId: 'c1' }]);
    expect(isMediaGone('hid')).toBe(false);
    expect(flattenMedia([photoHit('hid')], 'photo')).toHaveLength(1);
  });

  it('once the hide is written its items leave every list and the cached first page', async () => {
    const key = readKey(USER, WS, mediaCacheWhat('photo'));
    primeRead<MediaCacheValue>(key, {
      kind: 'photo',
      items: flattenHits([photoHit('keep'), photoHit('hid')], 'photo', opts),
    });
    await hideMessages({
      userId: USER,
      workspaceId: WS,
      items: [{ messageId: 'hid', channelId: 'c1' }],
      traceId: 't',
      client: okClient(),
    });
    expect(isMediaGone('hid')).toBe(true);
    expect(peekKept<MediaCacheValue>(key)?.items.map((i) => i.messageId)).toEqual(['keep']);
    expect(
      flattenMedia([photoHit('keep'), photoHit('hid')], 'photo').map((i) => i.messageId),
    ).toEqual(['keep']);
  });
});
