// A press on a chat row (pointerdown, before the tap) starts the open's one
// chat_open_bundle read; the tap's kickoff and the thread's switch join it, so
// the press and the tap share exactly one read. A chat whose pre-warm the tap
// will take reads nothing on the press, and the press never spends it.
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
  createOpenCache,
  kickoffChatOpen,
  type ChatKey,
  type OpenCache,
} from '@/lib/chat/open-cache';
import {
  joinChatBundle,
  joinableChatBundle,
  pressChatBundle,
  type ChatBundleDeps,
} from '@/lib/chat/open-bundle';
import { prewarmChats } from '@/lib/chat/use-chat-thread';
import {
  PRESS_SETTLE_MS,
  PRESS_SLOP_PX,
  createPressIntent,
  type PressIntent,
  type PressIntentDeps,
} from '@/lib/chat/press-intent';
import type { ChatMessageRow } from '@/lib/chat/thread';
import { resetSessionReads } from '@/lib/session-read';

const KEY: ChatKey = { userId: 'u1', workspaceId: 'w1', channelId: 'c1' };

function row(n: number): ChatMessageRow {
  return {
    id: `m${n}`,
    channel_id: 'c1',
    workspace_id: 'w1',
    sender_user_id: 'u2',
    body: `body ${n}`,
    mentions: null,
    attachment_asset_ids: null,
    shared_post_ids: null,
    shared_brief_ids: null,
    shared_plan_ids: null,
    reply_to_message_id: null,
    forwarded_from_message_id: null,
    attachment_meta: null,
    agora_event_id: null,
    created_at: new Date(Date.UTC(2026, 9, 26, 10, 0, n)).toISOString(),
    edited_at: null,
    deleted_at: null,
    thread_root_message_id: null,
    removed_files: [],
  };
}

function bundle(): ChatOpenBundle {
  return {
    serverNow: '2026-10-26T10:01:00Z',
    page: { rows: [row(1), row(2), row(3)], hasMore: false },
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
    // The workspace parts derive from the bundle; no shared session store here.
    share: (_userId, _workspaceId, _what, load) => load(),
    traceId: () => '0190a000-0000-7000-8000-0000000000bb',
  };
}

/** The tap, as ChatConnected's startChatOpen runs it over these deps. */
function tap(store: OpenCache, d: ChatBundleDeps): void {
  kickoffChatOpen(
    KEY,
    { bundle: (k) => void joinChatBundle(k, { deps: d }), viewerSide: () => {} },
    store,
  );
}

afterEach(() => {
  vi.useRealTimers();
  resetSessionReads();
});

describe('press-in starts the open bundle; the tap joins it', () => {
  it('a cold chat: one read, started at the press, shared by tap and thread', async () => {
    const store = createOpenCache();
    const d = deps(store);
    // The press stashes the open's bundle at once; its read (withReadTimeout)
    // runs one microtask later, so the counts are checked once it settled.
    const pressed = pressChatBundle(KEY, { deps: d });
    expect(pressed).not.toBeNull();
    expect(joinableChatBundle(KEY, store)).toBe(pressed);
    tap(store, d);
    // The thread's switch joins the same read too.
    expect(joinChatBundle(KEY, { deps: d })).toBe(pressed);
    expect(joinableChatBundle(KEY, store)).toBe(pressed);
    await pressed;
    expect(d.asked).toHaveLength(1);
    expect(d.asked[0]?.since).toBeNull();
  });

  it('a second press (pointerdown then a repeat) never starts a second read', async () => {
    const store = createOpenCache();
    const d = deps(store);
    const first = pressChatBundle(KEY, { deps: d });
    const second = pressChatBundle(KEY, { deps: d });
    expect(second).toBe(first);
    tap(store, d);
    expect(joinableChatBundle(KEY, store)).toBe(first);
    await first;
    expect(d.asked).toHaveLength(1);
  });

  it('a remembered chat: the press asks p_since and the reopen joins it (one read)', async () => {
    const store = createOpenCache();
    const through = { createdAt: '2026-10-26T10:00:02.000Z', id: 'm2' };
    store.remember(KEY, 'thread', {
      rows: [],
      hasMore: false,
      through,
      reads: null,
      unresolved: [],
    });
    const d = deps(store);
    const pressed = pressChatBundle(KEY, { deps: d });
    tap(store, d);
    // The reopen's revalidation asks the bundle from the page end: the press's.
    expect(joinChatBundle(KEY, { since: through.createdAt, deps: d })).toBe(pressed);
    await pressed;
    expect(d.asked).toHaveLength(1);
    expect(d.asked[0]?.since).toBe(through.createdAt);
  });

  it('a held pre-warm: the press reads nothing and leaves it for the tap', async () => {
    const store = createOpenCache();
    const d = deps(store);
    const kept = await prewarmChats([KEY], {
      store,
      read: () => Promise.resolve({ ok: true, data: bundle() }),
      saveData: () => false,
      current: () => true,
    });
    expect(kept).toBe(1);
    expect(store.holdsPrewarm(KEY)).toBe(true);
    expect(pressChatBundle(KEY, { deps: d })).toBeNull();
    // Never spent by the press.
    expect(store.holdsPrewarm(KEY)).toBe(true);
    tap(store, d);
    // The tap took it: the open's bundle is the pre-warm's, nothing read.
    expect(store.holdsPrewarm(KEY)).toBe(false);
    expect(joinableChatBundle(KEY, store)).not.toBeNull();
    expect(d.asked).toHaveLength(0);
  });

  it('a stale pre-warm is not held: the press reads, the tap joins it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-26T10:05:00Z'));
    const store = createOpenCache();
    const d = deps(store);
    await prewarmChats([KEY], {
      store,
      read: () => Promise.resolve({ ok: true, data: bundle() }),
      saveData: () => false,
      current: () => true,
    });
    vi.setSystemTime(new Date('2026-10-26T10:06:30Z'));
    expect(store.holdsPrewarm(KEY)).toBe(false);
    const pressed = pressChatBundle(KEY, { deps: d });
    expect(pressed).not.toBeNull();
    tap(store, d);
    expect(joinableChatBundle(KEY, store)).toBe(pressed);
    await pressed;
    expect(d.asked).toHaveLength(1);
  });
});

/** A hand-driven clock and scroll source for the press intents. */
function fakeClock(): {
  deps: PressIntentDeps;
  advance: (ms: number) => void;
  scroll: () => void;
} {
  let now = 0;
  const timers = new Set<{ at: number; fn: () => void }>();
  const scrolls = new Set<() => void>();
  return {
    deps: {
      setTimer: (fn, ms) => {
        const timer = { at: now + ms, fn };
        timers.add(timer);
        return () => void timers.delete(timer);
      },
      watchScroll: (fn) => {
        scrolls.add(fn);
        return () => void scrolls.delete(fn);
      },
    },
    advance: (ms) => {
      now += ms;
      for (const timer of [...timers]) {
        if (timer.at > now) continue;
        timers.delete(timer);
        timer.fn();
      }
    },
    scroll: () => {
      for (const fn of [...scrolls]) fn();
    },
  };
}

const ROW_HEIGHT = 72;

/** Ten chat rows, each with its press intent wired as ChannelCard wires it. */
function tenRows(
  d: ChatBundleDeps,
  clock: ReturnType<typeof fakeClock>,
): Array<{ key: ChatKey; y: number; press: PressIntent }> {
  return Array.from({ length: 10 }, (_, i) => {
    const key: ChatKey = { ...KEY, channelId: `c${i}` };
    return {
      key,
      y: i * ROW_HEIGHT + ROW_HEIGHT / 2,
      press: createPressIntent(() => void pressChatBundle(key, { deps: d }), clock.deps),
    };
  });
}

describe('press-in never reads on a scroll', () => {
  it('a scroll gesture over 10 chat rows fires 0 bundle reads', async () => {
    const store = createOpenCache();
    const d = deps(store);
    const clock = fakeClock();
    const rows = tenRows(d, clock);
    // The finger lands on each row in turn as the list flicks under it.
    for (const row of rows) {
      row.press.down({ clientX: 100, clientY: row.y });
      clock.advance(16);
      // The pan: a move past the slop, then the browser's pointercancel.
      row.press.move({ clientX: 100, clientY: row.y - PRESS_SLOP_PX - 1 });
      row.press.cancel();
      clock.advance(PRESS_SETTLE_MS * 2);
    }
    // A still finger on a row while the list scrolls (momentum) is a scroll too.
    const resting = rows[4];
    resting?.press.down({ clientX: 100, clientY: resting.y });
    clock.advance(30);
    clock.scroll();
    clock.advance(PRESS_SETTLE_MS * 2);
    await Promise.resolve();
    await Promise.resolve();
    expect(d.asked).toHaveLength(0);
    for (const row of rows) expect(joinableChatBundle(row.key, store)).toBeNull();
  });

  it('a jitter inside the slop is still a press', async () => {
    const store = createOpenCache();
    const d = deps(store);
    const clock = fakeClock();
    const row = tenRows(d, clock)[2];
    if (row === undefined) throw new Error('no row');
    row.press.down({ clientX: 100, clientY: row.y });
    row.press.move({ clientX: 103, clientY: row.y + PRESS_SLOP_PX - 4 });
    clock.advance(PRESS_SETTLE_MS);
    const read = joinableChatBundle(row.key, store);
    expect(read).not.toBeNull();
    await read;
    expect(d.asked).toHaveLength(1);
  });

  it('a hover (no pointerdown) never arms a press', () => {
    const clock = fakeClock();
    const press = createPressIntent(() => {
      throw new Error('a hover must not read');
    }, clock.deps);
    press.move({ clientX: 10, clientY: 10 });
    clock.advance(PRESS_SETTLE_MS * 4);
    expect(press.armed()).toBe(false);
  });

  it('a tap held past 80 ms: one read, shared with the open', async () => {
    const store = createOpenCache();
    const d = deps(store);
    const clock = fakeClock();
    const row = tenRows(d, clock)[5];
    if (row === undefined) throw new Error('no row');
    row.press.down({ clientX: 100, clientY: row.y });
    clock.advance(PRESS_SETTLE_MS - 1);
    expect(joinableChatBundle(row.key, store)).toBeNull();
    clock.advance(1);
    const pressed = joinableChatBundle(row.key, store);
    expect(pressed).not.toBeNull();
    // The lift, then the tap's kickoff and the thread's switch join it.
    row.press.cancel();
    kickoffChatOpen(
      row.key,
      { bundle: (k) => void joinChatBundle(k, { deps: d }), viewerSide: () => {} },
      store,
    );
    expect(joinChatBundle(row.key, { deps: d })).toBe(pressed);
    await pressed;
    expect(d.asked).toHaveLength(1);
    expect(d.asked[0]?.channelId).toBe('c5');
  });

  it('a quick tap (lift before 80 ms): the press reads nothing, the tap reads once', async () => {
    const store = createOpenCache();
    const d = deps(store);
    const clock = fakeClock();
    const row = tenRows(d, clock)[7];
    if (row === undefined) throw new Error('no row');
    row.press.down({ clientX: 100, clientY: row.y });
    clock.advance(40);
    row.press.cancel();
    clock.advance(PRESS_SETTLE_MS * 2);
    expect(joinableChatBundle(row.key, store)).toBeNull();
    kickoffChatOpen(
      row.key,
      { bundle: (k) => void joinChatBundle(k, { deps: d }), viewerSide: () => {} },
      store,
    );
    const opened = joinableChatBundle(row.key, store);
    expect(joinChatBundle(row.key, { deps: d })).toBe(opened);
    await opened;
    expect(d.asked).toHaveLength(1);
  });
});
