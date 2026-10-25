import { afterEach, describe, expect, it, vi } from 'vitest';

// sameMarks' module reaches the agora-chat browser SDK through the message
// factory; mock it so the pure pieces import in node.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import type { Client, Result } from '@srtdio/rpc';
import {
  JOIN_WINDOW_MS,
  OPEN_CACHE_LIMIT,
  OPEN_HOLD_MS,
  chatKey,
  clearOpenCache,
  createOpenCache,
  kickoffChatOpen,
  openCache,
  openChatPlans,
  unwatchSignOut,
  watchSignOut,
  type ChatKey,
  type OpenKickoffReads,
  type SignOutSource,
} from '@/lib/chat/open-cache';
import {
  clearMessagePrefetch,
  HISTORY_PAGE_SIZE,
  prefetchLatestMessages,
  readLatestMessages,
} from '@/lib/chat/history';
import { sameMarks } from '@/lib/chat/use-chat-marks';
import { settleOpenPosts, type OpenPostsData } from '@/lib/chat/use-open-posts';
import { settleStatusRound, type StatusRound } from '@/lib/chat/use-status-counts';
import type { PlanCardCache } from '@/lib/chat/plans';
import type { ChatMark } from '@/lib/chat/marks';

const A: ChatKey = { userId: 'u1', workspaceId: 'w1', channelId: 'c1' };
const B: ChatKey = { userId: 'u1', workspaceId: 'w1', channelId: 'c2' };
const VIEW = { posts: [], count: 0, failed: false };

/** A plan cache that records what was asked of it. */
function fakePlans(): PlanCardCache & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    request: (ids) => calls.push(`request ${ids.join(',')}`),
    refresh: (ids) => calls.push(`refresh ${ids.join(',')}`),
    retryFailed: () => undefined,
    retry: () => undefined,
    snapshot: () => ({ loading: false, bundles: new Map(), failed: [] }),
    knows: () => false,
    revalidate: () => calls.push('revalidate'),
    subscribe: () => () => undefined,
    version: () => 0,
    dispose: () => calls.push('dispose'),
    resume: () => calls.push('resume'),
  };
}

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
    const plans = fakePlans();
    cache.planCache(A, () => plans);
    cache.remember(A, 'openPosts', VIEW);
    cache.remember({ ...A, workspaceId: 'w2' }, 'openPosts', VIEW);
    expect(cache.size()).toBe(1);
    expect(cache.recall(A, 'openPosts')).toBeUndefined();
    expect(plans.calls).toContain('dispose');
  });

  it('keeps the most recently used chats, capped (LRU)', () => {
    expect(OPEN_CACHE_LIMIT).toBe(20);
    const cache = createOpenCache({ limit: 3 });
    const evicted = fakePlans();
    const key = (n: number): ChatKey => ({ ...A, channelId: `c${n}` });
    cache.planCache(key(1), () => evicted);
    cache.remember(key(2), 'openPosts', VIEW);
    cache.remember(key(3), 'openPosts', VIEW);
    // Touching 2 makes 1 the oldest.
    cache.recall(key(2), 'openPosts');
    cache.remember(key(4), 'openPosts', VIEW);
    expect(cache.size()).toBe(3);
    expect(evicted.calls).toContain('dispose');
    expect(cache.recall(key(2), 'openPosts')).toBe(VIEW);
    cache.remember(key(5), 'openPosts', VIEW);
    expect(cache.recall(key(3), 'openPosts')).toBeUndefined();
  });

  it('a clear disposes every plan cache and calls back once', () => {
    const onClear = vi.fn();
    const cache = createOpenCache({ onClear });
    const plans = fakePlans();
    cache.planCache(A, () => plans);
    cache.clear();
    expect(plans.calls).toEqual(['dispose']);
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

/** Fake reads that record their start; each resolves when told. */
function fakeReads(): {
  reads: OpenKickoffReads;
  started: string[];
  planIds: (ids: string[]) => void;
} {
  const started: string[] = [];
  let answerPlanIds: (r: Result<string[]>) => void = () => undefined;
  const never = <T>(name: string): Promise<T> => {
    started.push(name);
    return new Promise<T>(() => undefined);
  };
  return {
    started,
    planIds: (ids) => answerPlanIds({ ok: true, data: ids }),
    reads: {
      messages: () => void started.push('messages'),
      viewerSide: () => void started.push('viewerSide'),
      marks: () => never('marks'),
      openPosts: () => never('openPosts'),
      planIds: () => {
        started.push('planIds');
        return new Promise((resolve) => {
          answerPlanIds = resolve;
        });
      },
      briefs: () => never('briefs'),
      briefCount: () => never('briefCount'),
    },
  };
}

describe('kickoffChatOpen', () => {
  it('starts every read at once; none waits for the messages page', () => {
    const cache = createOpenCache();
    const plans = fakePlans();
    const { reads, started } = fakeReads();
    kickoffChatOpen(A, reads, cache, () => plans);
    // All seven start in the tap's own task (the messages page never answers here).
    expect([...started].sort()).toEqual(
      ['briefCount', 'briefs', 'marks', 'messages', 'openPosts', 'planIds', 'viewerSide'].sort(),
    );
  });

  it('feeds the plan ids to the chat plan cache the moment they are in', async () => {
    const cache = createOpenCache();
    const plans = fakePlans();
    const { reads, planIds } = fakeReads();
    kickoffChatOpen(A, reads, cache, () => plans);
    expect(plans.calls.filter((c) => c.startsWith('request'))).toEqual([]);
    planIds(['p1', 'p2']);
    await Promise.resolve();
    await Promise.resolve();
    expect(plans.calls).toContain('request p1,p2');
  });

  it('a second kickoff in the same open joins the reads (no duplicates)', () => {
    const cache = createOpenCache();
    const { reads, started } = fakeReads();
    kickoffChatOpen(A, reads, cache, fakePlans);
    const first = started.filter((s) => s !== 'messages' && s !== 'viewerSide').length;
    kickoffChatOpen(A, reads, cache, fakePlans);
    expect(started.filter((s) => s !== 'messages' && s !== 'viewerSide')).toHaveLength(first);
  });

  it('a reopen revalidates the remembered plan cache in the background', () => {
    let t = 0;
    const cache = createOpenCache({ now: () => t });
    const plans = fakePlans();
    expect(openChatPlans(A, cache, () => plans).fresh).toBe(true);
    // The provider's mount right after the tap: the same open, no second read.
    expect(openChatPlans(A, cache, () => plans).fresh).toBe(false);
    t += JOIN_WINDOW_MS;
    const again = openChatPlans(A, cache, () => fakePlans());
    expect(again.cache).toBe(plans);
    expect(plans.calls.filter((c) => c === 'revalidate')).toHaveLength(2);
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

describe('the messages page started at the tap', () => {
  function pageClient(): { client: Client; selects: () => number } {
    let n = 0;
    const q: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'gte', 'lt', 'lte', 'order', 'limit', 'abortSignal']) {
      q[m] = () => q;
    }
    // A full page: the first partition-bounded window fills it (no floor probe).
    const full = Array.from({ length: HISTORY_PAGE_SIZE }, (_, i) => ({ id: `m${i}` }));
    q.then = (resolve: (v: unknown) => unknown) => {
      n += 1;
      return Promise.resolve({ data: full, error: null }).then(resolve);
    };
    return { client: { from: () => q } as unknown as Client, selects: () => n };
  }

  it("the thread's open joins the tap's read (one select), and a clear forgets it", async () => {
    const { client, selects } = pageClient();
    prefetchLatestMessages(client, 'c1');
    prefetchLatestMessages(client, 'c1');
    const page = await readLatestMessages(client, 'c1', new AbortController().signal);
    expect(page.ok).toBe(true);
    expect(selects()).toBe(1);
    clearMessagePrefetch();
    await readLatestMessages(client, 'c1');
    expect(selects()).toBe(2);
  });

  it('a cancelled wait settles at once as a failure', async () => {
    const { client } = pageClient();
    prefetchLatestMessages(client, 'c9');
    const abort = new AbortController();
    abort.abort();
    const result = await readLatestMessages(client, 'c9', abort.signal);
    expect(result.ok).toBe(false);
    clearMessagePrefetch();
  });
});
