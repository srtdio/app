// Same-session chat memory (D3): a remembered message page, marks, scheduled
// rows and cursors from an earlier open are allowed only when (a) they live
// in memory only, never in localStorage, sessionStorage or IndexedDB; (b)
// they are forgotten on sign-out AND at once on a workspace switch; (c) every
// reopen runs chat_open_bundle with p_since at once (at the tap, no timer, no
// visibility wait).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => {
      throw new Error('the app client is never read in this test');
    },
    rpc: () => {
      throw new Error('the app client is never called in this test');
    },
    auth: {
      getSession: () => Promise.resolve({ data: { session: null } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
  },
}));

import type { Result } from '@srtdio/rpc';
import type { ChatOpenBundle, ChatOpenBundleInput } from '@/lib/chat/history';
import {
  chatScopeLeft,
  createOpenCache,
  kickoffChatOpen,
  leaveChatScope,
  withOwnCursor,
  type ChatKey,
  type OpenCache,
  type RememberedThread,
} from '@/lib/chat/open-cache';
import { joinChatBundle, startChatBundle, type ChatBundleDeps } from '@/lib/chat/open-bundle';
import { revalidateRemembered } from '@/lib/chat/use-chat-thread';
import { resetSessionReads } from '@/lib/session-read';
import { sharedChatRead } from '@/lib/chat/workspace-reads';
import type { ChatMark } from '@/lib/chat/marks';
import type { ThreadMessage } from '@/lib/chat/thread';

const KEY: ChatKey = { userId: 'u1', workspaceId: 'w1', channelId: 'c1' };
const THROUGH = { createdAt: '2026-10-26T10:00:02.000Z', id: 'm2' };

function bundle(): ChatOpenBundle {
  return {
    serverNow: '2026-10-26T10:01:00Z',
    page: { rows: [], hasMore: false },
    quoted: [],
    reactions: [],
    readPositions: { rows: [], times: new Map() },
    replyCounts: new Map(),
    marks: [],
    scheduled: [],
    openPosts: [],
    openPostCount: 0,
    sharedPlanIds: [],
    openBriefs: [],
    openBriefCount: 0,
  };
}

function deps(store: OpenCache): ChatBundleDeps & { asked: ChatOpenBundleInput[] } {
  const asked: ChatOpenBundleInput[] = [];
  return {
    asked,
    store,
    read: (input) => {
      asked.push(input);
      return Promise.resolve<Result<ChatOpenBundle>>({ ok: true, data: bundle() });
    },
    share: sharedChatRead,
    traceId: () => '0190a000-0000-7000-8000-0000000000bb',
  };
}

function page(): RememberedThread {
  return {
    rows: [],
    hasMore: false,
    through: THROUGH,
    reads: withOwnCursor(
      { rows: [], times: new Map() },
      'u1',
      { id: 'm2', time: 2 },
      THROUGH.createdAt,
    ),
    unresolved: [],
  };
}

/** Everything a chat remembers, held for KEY. */
function holdAll(store: OpenCache): void {
  const owner = store.attach(KEY);
  owner.keep(page());
  owner.release();
  store.remember(KEY, 'marks', {
    marks: new Map<string, ChatMark>(),
    markedMessages: new Map<string, ThreadMessage>(),
  });
  store.remember(KEY, 'scheduled', []);
}

/** Microtasks only: no timer runs. */
async function microtasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

afterEach(() => {
  resetSessionReads();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('(a) chat memory is in memory only', () => {
  it('holding, revising and catching up a chat never touches browser storage', async () => {
    const touched: string[] = [];
    const storage = (name: string): Storage =>
      ({
        getItem: (k: string) => {
          touched.push(`${name}.get ${k}`);
          return null;
        },
        setItem: (k: string) => void touched.push(`${name}.set ${k}`),
        removeItem: (k: string) => void touched.push(`${name}.remove ${k}`),
        clear: () => void touched.push(`${name}.clear`),
        key: () => null,
        length: 0,
      }) as Storage;
    vi.stubGlobal('localStorage', storage('localStorage'));
    vi.stubGlobal('sessionStorage', storage('sessionStorage'));
    vi.stubGlobal('indexedDB', {
      open: () => {
        touched.push('indexedDB.open');
        throw new Error('never opened');
      },
    });
    const store = createOpenCache();
    holdAll(store);
    store.revise(KEY, 'scheduled', (rows) => [...rows]);
    await startChatBundle(KEY, { deps: deps(store) });
    store.recall(KEY, 'thread');
    store.clear();
    expect(touched).toEqual([]);
  });

  it('the memory modules name no browser storage API', () => {
    const files = [
      '../open-cache.ts',
      '../open-bundle.ts',
      '../use-chat-thread.ts',
      '../use-chat-marks.ts',
      '../marks.ts',
      '../scheduled.ts',
      '../read-receipts.ts',
      '../history.ts',
      '../workspace-reads.ts',
    ];
    for (const file of files) {
      const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
      expect(source, file).not.toMatch(/localStorage|sessionStorage|indexedDB|IDBFactory/);
    }
  });
});

describe('(b) forgotten on sign-out and on a workspace switch', () => {
  it('names the scope left: a switch, another user, sign-out; none when it stayed', () => {
    const a = { userId: 'u1', workspaceId: 'w1' };
    expect(chatScopeLeft(null, a)).toBeNull();
    expect(chatScopeLeft(a, { ...a })).toBeNull();
    expect(chatScopeLeft(a, { userId: 'u1', workspaceId: 'w2' })).toEqual(a);
    expect(chatScopeLeft(a, { userId: 'u2', workspaceId: 'w1' })).toEqual(a);
    expect(chatScopeLeft(a, null)).toEqual(a);
  });

  it('a workspace switch forgets the page, marks, scheduled rows and cursors at once', () => {
    const store = createOpenCache();
    holdAll(store);
    // Nothing of the new workspace was touched yet: the switch alone clears.
    leaveChatScope({ userId: 'u1', workspaceId: 'w1' }, { userId: 'u1', workspaceId: 'w2' }, store);
    expect(store.size()).toBe(0);
    expect(store.recall(KEY, 'thread')).toBeUndefined();
    expect(store.recall(KEY, 'marks')).toBeUndefined();
    expect(store.recall(KEY, 'scheduled')).toBeUndefined();
  });

  it('sign-out forgets everything at once', () => {
    const store = createOpenCache();
    holdAll(store);
    leaveChatScope({ userId: 'u1', workspaceId: 'w1' }, null, store);
    expect(store.size()).toBe(0);
  });

  it('the same scope keeps it; a new workspace open made first is never dropped', () => {
    const store = createOpenCache();
    holdAll(store);
    leaveChatScope({ userId: 'u1', workspaceId: 'w1' }, { userId: 'u1', workspaceId: 'w1' }, store);
    expect(store.recall(KEY, 'thread')).toBeDefined();
    // The new workspace's chat opened before the shell's switch effect ran:
    // entering it already dropped w1; leaving w1 now leaves the new open be.
    const other: ChatKey = { userId: 'u1', workspaceId: 'w2', channelId: 'c9' };
    store.remember(other, 'scheduled', []);
    expect(store.recall(KEY, 'thread')).toBeUndefined();
    leaveChatScope({ userId: 'u1', workspaceId: 'w1' }, { userId: 'u1', workspaceId: 'w2' }, store);
    expect(store.recall(other, 'scheduled')).toEqual([]);
  });
});

describe('(c) every reopen catches up with p_since at once', () => {
  it('the tap on a remembered chat starts chat_open_bundle with p_since, no timer', async () => {
    vi.useFakeTimers();
    const store = createOpenCache();
    holdAll(store);
    const d = deps(store);
    kickoffChatOpen(
      KEY,
      { bundle: (k) => void joinChatBundle(k, { deps: d }), viewerSide: () => {} },
      store,
    );
    await microtasks();
    expect(d.asked).toHaveLength(1);
    expect(d.asked[0]?.since).toBe(THROUGH.createdAt);
  });

  it("the reopen's catch-up asks its bundle in the same tick it starts", () => {
    const since: Array<string | null> = [];
    const pending = new Promise<never>(() => {});
    void revalidateRemembered(
      {
        loadBundle: (s) => {
          since.push(s);
          return pending;
        },
        loadByIds: () => pending,
        loadReactions: () => pending,
      },
      page(),
      new AbortController().signal,
    );
    expect(since).toEqual([THROUGH.createdAt]);
  });

  it("the thread's own catch-up joins the tap's call (one call, p_since)", async () => {
    const store = createOpenCache();
    holdAll(store);
    const d = deps(store);
    const tap = joinChatBundle(KEY, { deps: d });
    expect(joinChatBundle(KEY, { since: THROUGH.createdAt, deps: d })).toBe(tap);
    await tap;
    expect(d.asked.map((a) => a.since)).toEqual([THROUGH.createdAt]);
  });
});
