import { afterEach, describe, expect, it, vi } from 'vitest';

// sameMarks' module reaches the agora-chat browser SDK through the message
// factory; mock it so the pure pieces import in node.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import type { Result } from '@srtdio/rpc';
import {
  JOIN_WINDOW_MS,
  OPEN_CACHE_LIMIT,
  OPEN_HOLD_MS,
  chatKey,
  clearOpenCache,
  createOpenCache,
  kickoffChatOpen,
  openCache,
  unwatchSignOut,
  watchSignOut,
  type ChatKey,
  type OpenKickoffReads,
  type SignOutSource,
} from '@/lib/chat/open-cache';
import { sameMarks } from '@/lib/chat/use-chat-marks';
import { settleOpenPosts, type OpenPostsData } from '@/lib/chat/use-open-posts';
import { settleStatusRound, type StatusRound } from '@/lib/chat/use-status-counts';
import type { ChatMark } from '@/lib/chat/marks';
import { READ_FRESH_MS } from '@/lib/session-read';

const A: ChatKey = { userId: 'u1', workspaceId: 'w1', channelId: 'c1' };
const B: ChatKey = { userId: 'u1', workspaceId: 'w1', channelId: 'c2' };
const VIEW = { posts: [], count: 0, failed: false };

afterEach(() => {
  clearOpenCache();
  unwatchSignOut();
  vi.useRealTimers();
});

describe('open cache keying', () => {
  it('keys memory by user, workspace and chat', () => {
    const cache = createOpenCache();
    cache.remember(A, 'openPosts', VIEW);
    expect(cache.recall(A, 'openPosts')).toBe(VIEW);
    expect(cache.recall(B, 'openPosts')).toBeUndefined();
    expect(chatKey('u1', 'w1', null)).toBeNull();
    expect(chatKey(null, 'w1', 'c1')).toBeNull();
    expect(chatKey('u1', 'w1', 'c1')).toEqual(A);
  });

  it('another user forgets everything held, before answering', () => {
    const onClear = vi.fn();
    const cache = createOpenCache({ onClear });
    cache.remember(A, 'openPosts', VIEW);
    cache.remember(B, 'openPosts', VIEW);
    expect(cache.recall({ ...A, userId: 'u2' }, 'openPosts')).toBeUndefined();
    expect(cache.size()).toBe(0);
    expect(onClear).toHaveBeenCalledTimes(1);
    // The first user's chat is gone too: nothing comes back for them.
    expect(cache.recall(A, 'openPosts')).toBeUndefined();
  });

  it('a workspace switch forgets everything held', () => {
    const cache = createOpenCache();
    cache.remember(A, 'openPosts', VIEW);
    cache.remember({ ...A, workspaceId: 'w2' }, 'openPosts', VIEW);
    expect(cache.size()).toBe(1);
    expect(cache.recall(A, 'openPosts')).toBeUndefined();
  });

  it('keeps the most recently used chats, capped (LRU)', () => {
    expect(OPEN_CACHE_LIMIT).toBe(20);
    const cache = createOpenCache({ limit: 3 });
    const key = (n: number): ChatKey => ({ ...A, channelId: `c${n}` });
    cache.remember(key(1), 'openPosts', VIEW);
    cache.remember(key(2), 'openPosts', VIEW);
    cache.remember(key(3), 'openPosts', VIEW);
    // Touching 2 makes 1 the oldest.
    cache.recall(key(2), 'openPosts');
    cache.remember(key(4), 'openPosts', VIEW);
    expect(cache.size()).toBe(3);
    expect(cache.recall(key(1), 'openPosts')).toBeUndefined();
    expect(cache.recall(key(2), 'openPosts')).toBe(VIEW);
    cache.remember(key(5), 'openPosts', VIEW);
    expect(cache.recall(key(3), 'openPosts')).toBeUndefined();
  });

  it('a clear forgets every chat and calls back once', () => {
    const onClear = vi.fn();
    const cache = createOpenCache({ onClear });
    cache.remember(A, 'openPosts', VIEW);
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});

describe('stashed reads', () => {
  it('joins a read while it runs and for the join window after, then reads again', async () => {
    let t = 0;
    const cache = createOpenCache({ now: () => t });
    const start = vi.fn(async (): Promise<OpenPostsData> => ({ posts: [], count: 0 }));
    const first = cache.joinOrStart(A, 'openPosts', start);
    // StrictMode's second mount, or the hook after the tap: the same read.
    expect(cache.joinOrStart(A, 'openPosts', start)).toBe(first);
    await first;
    t += JOIN_WINDOW_MS - 1;
    expect(cache.joinable(A, 'openPosts')).toBe(true);
    t += 1;
    expect(cache.join(A, 'openPosts')).toBeNull();
    void cache.joinOrStart(A, 'openPosts', start);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('notes a fresh open once per join window', () => {
    let t = 1_000;
    const cache = createOpenCache({ now: () => t });
    expect(cache.opened(A)).toBe(true);
    expect(cache.openedAt(A)).toBe(1_000);
    t += 10;
    expect(cache.opened(A)).toBe(false);
    t += JOIN_WINDOW_MS;
    expect(cache.opened(A)).toBe(true);
    expect(OPEN_HOLD_MS).toBe(1_000);
  });
});

/** Fake kickoff reads that record their start. */
function fakeReads(): { reads: OpenKickoffReads; started: string[] } {
  const started: string[] = [];
  return {
    started,
    reads: {
      bundle: (key) => void started.push(`bundle ${key.channelId}`),
      viewerSide: () => void started.push('viewerSide'),
    },
  };
}

describe('kickoffChatOpen', () => {
  it('starts the one bundle call and the viewer side at once, and notes the open', () => {
    let t = 5_000;
    const cache = createOpenCache({ now: () => t });
    const { reads, started } = fakeReads();
    kickoffChatOpen(A, reads, cache);
    expect([...started].sort()).toEqual(['bundle c1', 'viewerSide']);
    expect(cache.openedAt(A)).toBe(5_000);
    // The provider's mount right after the tap is the same open.
    t += 10;
    expect(cache.opened(A)).toBe(false);
  });

  it('never starts a plan bundle read (no plan cache is remembered)', () => {
    const cache = createOpenCache();
    const { reads, started } = fakeReads();
    kickoffChatOpen(A, reads, cache);
    expect(started.some((s) => s.includes('plan'))).toBe(false);
  });

  it('a Retry stash replaces a read that could still be joined', async () => {
    const cache = createOpenCache();
    const failed: Promise<Result<string[]>> = Promise.resolve({
      ok: false,
      error: { code: 'unknown', message: 'x' },
    });
    cache.stash(A, 'planIds', failed);
    await failed;
    const fresh: Promise<Result<string[]>> = Promise.resolve({ ok: true, data: ['p1'] });
    // Without replace the failed one is still joinable (the join window).
    cache.stash(A, 'planIds', fresh);
    expect(cache.join(A, 'planIds')).toBe(failed);
    cache.stash(A, 'planIds', fresh, true);
    expect(cache.join(A, 'planIds')).toBe(fresh);
  });
});

describe('sign-out', () => {
  function source(): SignOutSource & {
    auth: (userId: string | null) => void;
    target: EventTarget;
  } {
    let listener: (userId: string | null) => void = () => undefined;
    const target = new EventTarget();
    return {
      auth: (userId) => listener(userId),
      onAuthUser: (l) => {
        listener = l;
        return () => {
          listener = () => undefined;
        };
      },
      target: target as unknown as Window,
      signOutEvent: 'sorted:signout',
    } as SignOutSource & { auth: (userId: string | null) => void; target: EventTarget };
  }

  it('clears on SIGNED_OUT, on another user and on the sign-out event; same user keeps it', () => {
    const s = source();
    /** Watch with the fake source while one chat is held. */
    const hold = (): void => {
      unwatchSignOut();
      watchSignOut(s, openCache.heldUser);
      openCache.remember(A, 'openPosts', VIEW);
    };
    hold();
    s.auth('u1');
    expect(openCache.size()).toBe(1);
    s.auth(null);
    expect(openCache.size()).toBe(0);
    hold();
    s.auth('u2');
    expect(openCache.size()).toBe(0);
    hold();
    s.target.dispatchEvent(new Event('sorted:signout'));
    expect(openCache.size()).toBe(0);
  });

  it('a clear stops the watch; the next chat held starts it again', () => {
    const s = source();
    watchSignOut(s, openCache.heldUser);
    openCache.remember(A, 'openPosts', VIEW);
    s.auth(null);
    expect(openCache.size()).toBe(0);
    // The fake no longer reaches the store (the watch went with the clear).
    unwatchSignOut();
    openCache.remember(A, 'openPosts', VIEW);
    unwatchSignOut();
    s.auth(null);
    expect(openCache.size()).toBe(1);
  });

  it('stops listening once unwatched', () => {
    const s = source();
    watchSignOut(s, openCache.heldUser);
    unwatchSignOut();
    openCache.remember(A, 'openPosts', VIEW);
    s.target.dispatchEvent(new Event('sorted:signout'));
    s.auth(null);
    expect(openCache.size()).toBe(1);
  });
});

describe('same-data revalidation', () => {
  it('a same-data posts round keeps the held state itself', () => {
    const key = 'w1\nc1';
    const data: OpenPostsData = { posts: [], count: 2 };
    const first = settleOpenPosts(null, key, data);
    expect(settleOpenPosts(first, key, { posts: [], count: 2 })).toBe(first);
    expect(settleOpenPosts(first, key, { posts: [], count: 3 })).not.toBe(first);
  });

  it('a same-data ticker round keeps the held state itself', () => {
    const key = 'w1\nc1';
    const round: StatusRound = { planIds: ['p1'], briefs: [], briefCount: 0 };
    const first = settleStatusRound(null, key, round);
    expect(settleStatusRound(first, key, { planIds: ['p1'], briefs: [], briefCount: 0 })).toBe(
      first,
    );
    expect(settleStatusRound(first, key, { ...round, briefCount: 1 })).not.toBe(first);
  });

  it('same marks compare equal by content', () => {
    const mark = (resolved: boolean): ChatMark => ({
      messageId: 'm1',
      channelId: 'c1',
      type: 'pending',
      priority: null,
      markedAt: '2026-10-12T00:00:00Z',
      resolved,
      resolvedBy: null,
      resolvedAt: null,
    });
    expect(sameMarks(new Map([['m1', mark(false)]]), new Map([['m1', mark(false)]]))).toBe(true);
    expect(sameMarks(new Map([['m1', mark(false)]]), new Map([['m1', mark(true)]]))).toBe(false);
    expect(sameMarks(new Map(), new Map([['m1', mark(false)]]))).toBe(false);
  });
});

describe('recallFresh: an old answer is never painted', () => {
  const MARKS = { marks: new Map<string, ChatMark>(), markedMessages: new Map() };

  it('a part is recalled fresh within READ_FRESH_MS, absent after it', () => {
    let t = 1_000;
    const cache = createOpenCache({ now: () => t });
    cache.remember(A, 'marks', MARKS);
    cache.remember(A, 'scheduled', []);
    expect(cache.recallFresh(A, 'marks')).toBe(MARKS);
    t += READ_FRESH_MS;
    expect(cache.recallFresh(A, 'marks')).toBe(MARKS);
    t += 1;
    expect(cache.recallFresh(A, 'marks')).toBeUndefined();
    expect(cache.recallFresh(A, 'scheduled')).toBeUndefined();
    // Still held (a new read replaces it); only painting it is refused.
    expect(cache.recall(A, 'marks')).toBe(MARKS);
  });

  it('a live revise never makes a part fresher; a new read does', () => {
    let t = 1_000;
    const cache = createOpenCache({ now: () => t });
    cache.remember(A, 'marks', MARKS);
    t += READ_FRESH_MS + 1;
    cache.revise(A, 'marks', (value) => ({ ...value, markedMessages: new Map() }));
    expect(cache.recallFresh(A, 'marks')).toBeUndefined();
    cache.remember(A, 'marks', MARKS);
    expect(cache.recallFresh(A, 'marks')).toBe(MARKS);
  });

  it('a forgotten part is absent', () => {
    const cache = createOpenCache();
    cache.remember(A, 'scheduled', []);
    cache.forget(A, 'scheduled');
    expect(cache.recallFresh(A, 'scheduled')).toBeUndefined();
  });
});
