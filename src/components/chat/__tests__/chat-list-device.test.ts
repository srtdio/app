// Device cache, part B: the chat list. What a ready list paints is saved as a
// plain snapshot under `${userId}:${workspaceId}:chat:list`; a cold mount with
// a kept snapshot is 'ready' in its first render (the store's first state);
// the full load behind it replaces it in place; a failed one keeps it and
// never shows the list error.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import {
  chatListKey,
  initialListState,
  keptListSnapshot,
  listSnapshot,
  overSeeded,
  readListSnapshot,
  seedFromSnapshot,
  type ChatListSnapshot,
} from '@/components/chat/ChatStoreProvider';
import * as store from '@/lib/chat/chat-store';
import type { ChannelSummary } from '@/lib/chat-reads';
import { primeRead, resetSessionReads } from '@/lib/session-read';
import { isPersistable, setDeviceCacheBackend } from '@/lib/device-cache';

const ME = 'u1';
const WS = 'w1';
const SCOPE = store.loadScope(WS, ME);

function channel(id: string): ChannelSummary {
  return {
    channelId: id,
    channelType: 'dm',
    title: `Chat ${id}`,
    avatarUrl: null,
    agoraGroupId: null,
    groupId: null,
    peerUserId: 'p1',
    createdAt: '2026-10-01T00:00:00.000Z',
  };
}

const SNAPSHOT: ChatListSnapshot = {
  roster: [channel('c1'), channel('c2')],
  conversations: {
    c1: { lastMessageText: 'hi', lastMessageTs: 2, unread: 3 },
    c2: { lastMessageText: 'yo', lastMessageTs: 1, unread: 0 },
  },
  clears: {},
};

afterEach(() => {
  setDeviceCacheBackend(null);
  resetSessionReads();
});

describe('the chat list snapshot', () => {
  it('is saved under chat:list, on the device too', () => {
    expect(chatListKey(ME, WS)).toBe('u1:w1:chat:list');
    expect(isPersistable(chatListKey(ME, WS))).toBe(true);
  });

  it('is plain data: what a ready list paints, nothing about the open chat', () => {
    const ready = { ...seedFromSnapshot(store.initialState(), SCOPE, SNAPSHOT) };
    const snap = listSnapshot({ ...ready, activeConversationId: 'c1' });
    expect(snap).toEqual(SNAPSHOT);
    expect(JSON.parse(JSON.stringify(snap))).toEqual(SNAPSHOT);
    expect(readListSnapshot(JSON.parse(JSON.stringify(snap)))).toEqual(SNAPSHOT);
    expect(readListSnapshot(null)).toBeNull();
    expect(readListSnapshot({ roster: 'x' })).toBeNull();
  });

  it("a cold mount with a kept snapshot is 'ready' in the first render", () => {
    expect(initialListState(ME, WS).status).toBe('loading');
    primeRead(chatListKey(ME, WS), SNAPSHOT);
    const first = initialListState(ME, WS);
    expect(store.selectLoadStatus(first, SCOPE)).toBe('ready');
    expect(first.roster.map((c) => c.channelId)).toEqual(['c1', 'c2']);
    expect(store.selectTotalUnread(first)).toBe(3);
  });

  it('never paints another workspace or user', () => {
    primeRead(chatListKey(ME, WS), SNAPSHOT);
    expect(keptListSnapshot(ME, 'w2')).toBeNull();
    expect(keptListSnapshot('u2', WS)).toBeNull();
    expect(store.selectLoadStatus(initialListState(ME, 'w2'), store.loadScope('w2', ME))).toBe(
      'loading',
    );
  });

  it('the background load replaces the snapshot in place (still ready, no skeleton)', () => {
    const seeded = {
      ...seedFromSnapshot(store.initialState(), SCOPE, SNAPSHOT),
      activeConversationId: 'c2',
    };
    const next = overSeeded(
      seeded,
      (prev) =>
        store.loadReady(prev, {
          scope: SCOPE,
          roster: [channel('c3'), channel('c1')],
          clears: [],
          previews: [],
          counts: [],
          currentUserId: ME,
        }),
      true,
    );
    expect(next.status).toBe('ready');
    expect(next.roster.map((c) => c.channelId)).toEqual(['c3', 'c1']);
    expect(next.activeConversationId).toBe('c2');
  });

  it('a failed background load keeps the snapshot and never shows the list error', () => {
    const seeded = seedFromSnapshot(store.initialState(), SCOPE, SNAPSHOT);
    const fail = (prev: store.ChatStoreState): store.ChatStoreState =>
      store.loadFailed(prev, SCOPE);
    const kept = overSeeded(seeded, fail, true);
    expect(kept).toBe(seeded);
    expect(store.selectLoadStatus(kept, SCOPE)).toBe('ready');
    // Without a snapshot a failure is today's error state.
    const cold = store.beginLoad(store.initialState(), SCOPE);
    expect(overSeeded(cold, fail, false).status).toBe('error');
  });

  it('sign-out removes the snapshot', () => {
    primeRead(chatListKey(ME, WS), SNAPSHOT);
    resetSessionReads();
    expect(keptListSnapshot(ME, WS)).toBeNull();
  });
});
