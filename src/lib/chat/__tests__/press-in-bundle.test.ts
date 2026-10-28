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
  it('a cold chat: one bundle read, started at the press, shared by the tap and the thread', async () => {
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

  it('a stale pre-warm is not held: the press starts the reopen read, the tap joins it', async () => {
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
