// The pre-warm's one batched plan read is the first open's own plan read: one
// plan read per open in all, whichever side made it. It is handed to the
// first open that asks within PREWARM_FRESH_MS (joined while in flight), only
// when it asked every id that open asks; that first ask spends it, used or not,
// so a later open, a reopen or a plan-changed refetch always reads. A plan or
// post change drops it. It is skipped while a chat is open, never made under
// Save-Data, and forgotten with the chat memory.
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
import type { ChatOpenBundle } from '@/lib/chat/history';
import type { PlanBundle } from '@/lib/chat/plans';
import type { ChatMessageRow } from '@/lib/chat/thread';
import { createOpenCache, PREWARM_FRESH_MS, type ChatKey } from '@/lib/chat/open-cache';
import { openPlanIds, prewarmChats } from '@/lib/chat/use-chat-thread';

const A: ChatKey = { userId: 'u1', workspaceId: 'w1', channelId: 'a' };
const B: ChatKey = { userId: 'u1', workspaceId: 'w1', channelId: 'b' };

function row(channelId: string, n: number, plans: string[] | null = null): ChatMessageRow {
  return {
    id: `${channelId}-m${n}`,
    channel_id: channelId,
    workspace_id: 'w1',
    sender_user_id: 'u2',
    body: `body ${n}`,
    mentions: null,
    attachment_asset_ids: null,
    shared_post_ids: null,
    shared_brief_ids: null,
    shared_plan_ids: plans,
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

function bundle(channelId: string, pagePlans: string[], shared: string[]): ChatOpenBundle {
  return {
    serverNow: '2026-10-26T10:01:00Z',
    page: { rows: [row(channelId, 1), row(channelId, 2, pagePlans)], hasMore: false },
    quoted: [],
    reactions: [],
    readPositions: { rows: [], times: new Map() },
    replyCounts: new Map(),
    marks: [],
    scheduled: [],
    openPosts: [],
    openPostCount: 0,
    sharedPlanIds: shared,
    openBriefs: [],
    openBriefCount: 0,
  };
}

const BUNDLES: Record<string, ChatOpenBundle> = {
  a: bundle('a', ['p-page-a'], ['p-current']),
  b: bundle('b', [], ['p-current']),
};

function planReads(): {
  asked: string[][];
  readPlans: (ids: readonly string[]) => Promise<Result<Map<string, PlanBundle>>>;
} {
  const asked: string[][] = [];
  return {
    asked,
    readPlans: (ids) => {
      asked.push([...ids]);
      return Promise.resolve({
        ok: true,
        data: new Map(ids.map((id) => [id, { plan: { id } } as unknown as PlanBundle])),
      });
    },
  };
}

async function prewarm(
  store: ReturnType<typeof createOpenCache>,
  readPlans: (ids: readonly string[]) => Promise<Result<Map<string, PlanBundle>>>,
  onPlans?: (ids: readonly string[]) => void,
): Promise<number> {
  return prewarmChats([A, B], {
    store,
    read: (key) => Promise.resolve({ ok: true, data: BUNDLES[key.channelId] as ChatOpenBundle }),
    saveData: () => false,
    current: () => true,
    readPlans,
    ...(onPlans !== undefined ? { onPlans: (ids) => onPlans(ids) } : {}),
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the pre-warm plan read is the first open plan read', () => {
  it('one batched read for every warmed chat: shared plans and page plans, deduped', async () => {
    const store = createOpenCache();
    const { asked, readPlans } = planReads();
    let settled: readonly string[] = [];
    await prewarm(store, readPlans, (ids) => {
      settled = ids;
    });
    // The settle callback runs a few microtasks after the read answers.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(asked).toHaveLength(1);
    expect(new Set(asked[0])).toEqual(new Set(['p-current', 'p-page-a']));
    expect(new Set(settled)).toEqual(new Set(asked[0]));
    expect(openPlanIds(BUNDLES.a as ChatOpenBundle)).toEqual(['p-current', 'p-page-a']);
  });

  it('the first open takes it (no read of its own); spent: a refetch or reopen reads', async () => {
    const store = createOpenCache();
    const { asked, readPlans } = planReads();
    await prewarm(store, readPlans);
    const first = store.takePrewarmPlans(A, ['p-current', 'p-page-a']);
    expect(first).toBeDefined();
    const result = await first;
    expect(result?.ok === true ? [...result.data.keys()].sort() : null).toEqual([
      'p-current',
      'p-page-a',
    ]);
    // A plan-changed refetch in that open, the next open, a reopen: all read.
    expect(store.takePrewarmPlans(A, ['p-current'])).toBeUndefined();
    expect(store.takePrewarmPlans(B, ['p-current'])).toBeUndefined();
    expect(asked).toHaveLength(1);
  });

  it('an open asking an id the pre-warm did not read reads its own, and spends it', async () => {
    const store = createOpenCache();
    const { readPlans } = planReads();
    await prewarm(store, readPlans);
    expect(store.takePrewarmPlans(B, ['p-current', 'p-never-asked'])).toBeUndefined();
    expect(store.takePrewarmPlans(A, ['p-current'])).toBeUndefined();
  });

  it('later than PREWARM_FRESH_MS: never handed out', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-26T10:05:00Z'));
    const store = createOpenCache();
    const { readPlans } = planReads();
    await prewarm(store, readPlans);
    vi.setSystemTime(new Date(Date.now() + PREWARM_FRESH_MS + 1));
    expect(store.takePrewarmPlans(A, ['p-current'])).toBeUndefined();
  });

  it('another user or workspace never takes it', async () => {
    const store = createOpenCache();
    const { readPlans } = planReads();
    await prewarm(store, readPlans);
    expect(store.takePrewarmPlans({ ...A, userId: 'u9' }, ['p-current'])).toBeUndefined();
    // A different scope is not an ask of this one: it is still there for u1.
    expect(store.takePrewarmPlans(A, ['p-current'])).toBeDefined();
  });

  it('a plan or post change drops it, and so does the chat memory clear', async () => {
    const store = createOpenCache();
    const { readPlans } = planReads();
    await prewarm(store, readPlans);
    store.dropPrewarmPlans();
    expect(store.takePrewarmPlans(A, ['p-current'])).toBeUndefined();
    const cleared = createOpenCache();
    await prewarm(cleared, readPlans);
    cleared.clear();
    expect(cleared.takePrewarmPlans(A, ['p-current'])).toBeUndefined();
  });

  it('a read still in flight is joined: the open waits on the same read', async () => {
    const store = createOpenCache();
    let release: (value: Result<Map<string, PlanBundle>>) => void = () => {};
    const held = new Promise<Result<Map<string, PlanBundle>>>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    await prewarm(store, () => {
      calls += 1;
      return held;
    });
    const joined = store.takePrewarmPlans(A, ['p-current']);
    expect(joined).toBeDefined();
    release({ ok: true, data: new Map() });
    expect((await joined)?.ok).toBe(true);
    expect(calls).toBe(1);
  });

  it('skipped while a chat is open (its open already read its own)', async () => {
    const store = createOpenCache();
    const { asked, readPlans } = planReads();
    // A thread shows another chat: the pre-warm's plan read would only repeat its read.
    store.remember({ ...A, channelId: 'open' }, 'thread', {
      rows: [],
      hasMore: false,
      through: undefined,
      reads: null,
      unresolved: [],
    });
    const owner = store.attach({ ...A, channelId: 'open' });
    await prewarm(store, readPlans);
    expect(asked).toHaveLength(0);
    owner.release();
  });

  it('never under Save-Data, and never without a reader', async () => {
    const store = createOpenCache();
    const { asked, readPlans } = planReads();
    await prewarmChats([A, B], {
      store,
      read: (key) => Promise.resolve({ ok: true, data: BUNDLES[key.channelId] as ChatOpenBundle }),
      saveData: () => true,
      current: () => true,
      readPlans,
    });
    expect(asked).toHaveLength(0);
    const other = createOpenCache();
    await prewarmChats([A, B], {
      store: other,
      read: (key) => Promise.resolve({ ok: true, data: BUNDLES[key.channelId] as ChatOpenBundle }),
      saveData: () => false,
      current: () => true,
    });
    expect(other.takePrewarmPlans(A, ['p-current'])).toBeUndefined();
  });
});
