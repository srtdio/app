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
import { createOpenCache, type ChatKey, type OpenCache } from '@/lib/chat/open-cache';
import {
  joinChatBundle,
  joinableChatBundle,
  onChatBundle,
  rememberedSince,
  startChatBundle,
  type ChatBundleDeps,
} from '@/lib/chat/open-bundle';
import { resetSessionReads } from '@/lib/session-read';
import { sharedChatRead } from '@/lib/chat/workspace-reads';
import { bundlePlanIds, openPlansOnBundle } from '@/components/chat/PlanCardsProvider';
import { applyOpenBundle, runLatestLoad } from '@/lib/chat/use-chat-thread';
import { rowToThreadMessage, type ChatMessageRow } from '@/lib/chat/thread';

const KEY: ChatKey = { userId: 'u1', workspaceId: 'w1', channelId: 'c1' };

function row(n: number, extra: Partial<ChatMessageRow> = {}): ChatMessageRow {
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
    ...extra,
  };
}

function bundle(over: Partial<ChatOpenBundle> = {}): ChatOpenBundle {
  return {
    serverNow: '2026-10-26T10:01:00Z',
    page: { rows: [row(1), row(2)], hasMore: false },
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
    ...over,
  };
}

function deps(
  store: OpenCache,
  answer: () => Promise<Result<ChatOpenBundle>> = () =>
    Promise.resolve({ ok: true, data: bundle() }),
): ChatBundleDeps & { asked: ChatOpenBundleInput[] } {
  const asked: ChatOpenBundleInput[] = [];
  return {
    asked,
    store,
    read: (input) => {
      asked.push(input);
      return answer();
    },
    share: sharedChatRead,
    traceId: () => '0190a000-0000-7000-8000-0000000000aa',
  };
}

afterEach(() => resetSessionReads());

describe('one chat_open_bundle call per open', () => {
  it('the tap, the thread and every part join one call', async () => {
    const store = createOpenCache();
    const d = deps(store);
    const tap = joinChatBundle(KEY, { deps: d });
    // StrictMode's second render, the thread's switch: the same call.
    expect(joinChatBundle(KEY, { deps: d })).toBe(tap);
    expect(joinableChatBundle(KEY, store)).toBe(tap);
    await tap;
    expect(d.asked).toHaveLength(1);
    expect(d.asked[0]).toEqual({
      traceId: '0190a000-0000-7000-8000-0000000000aa',
      workspaceId: 'w1',
      channelId: 'c1',
      since: null,
    });
    const marks = await store.join(KEY, 'marks');
    const positions = await store.join(KEY, 'positions');
    const scheduled = await store.join(KEY, 'scheduled');
    expect([marks?.ok, positions?.ok, scheduled?.ok]).toEqual([true, true, true]);
    expect(d.asked).toHaveLength(1);
  });

  it('a reopen of a remembered chat asks p_since: the remembered page end (catch-up)', async () => {
    const store = createOpenCache();
    const through = { createdAt: '2026-10-26T10:00:02.000Z', id: 'm2' };
    store.remember(KEY, 'thread', {
      rows: [],
      hasMore: false,
      through,
      reads: null,
      unresolved: [],
    });
    expect(rememberedSince(KEY, store)).toBe(through.createdAt);
    const d = deps(store);
    await joinChatBundle(KEY, { deps: d });
    expect(d.asked[0]?.since).toBe(through.createdAt);
    // A different p_since never joins the stashed one: the cold open asks its own.
    await joinChatBundle(KEY, { since: null, deps: d });
    expect(d.asked.map((a) => a.since)).toEqual([through.createdAt, null]);
  });

  it('a Retry starts a fresh call even while the failed one could be joined', async () => {
    const store = createOpenCache();
    let fail = true;
    const d = deps(store, () =>
      Promise.resolve(
        fail
          ? { ok: false as const, error: { code: 'unknown' as const, message: 'down' } }
          : { ok: true as const, data: bundle() },
      ),
    );
    const first = await joinChatBundle(KEY, { deps: d });
    expect(first.ok).toBe(false);
    // Joining within the window gives the same failure back...
    expect((await joinChatBundle(KEY, { deps: d })).ok).toBe(false);
    expect(d.asked).toHaveLength(1);
    // ...the Retry replaces it, and its parts.
    fail = false;
    const retried = await startChatBundle(KEY, { deps: d });
    expect(retried.ok).toBe(true);
    expect((await store.join(KEY, 'marks'))?.ok).toBe(true);
    expect(d.asked).toHaveLength(2);
  });

  it('a failed bundle fails the thread open (the failed-load state) and every part', async () => {
    const store = createOpenCache();
    const refused: Result<ChatOpenBundle> = {
      ok: false,
      error: { code: 'workspace_member_only', message: 'workspace_member_only' },
    };
    const d = deps(store, () => Promise.resolve(refused));
    const outcome = await runLatestLoad(() => joinChatBundle(KEY, { deps: d }));
    expect(outcome.kind).toBe('failed');
    for (const name of ['marks', 'scheduled', 'positions'] as const) {
      expect((await store.join(KEY, name))?.ok).toBe(false);
    }
  });

  it('listeners hear each bundle settle, ok or failed', async () => {
    const store = createOpenCache();
    const heard: Array<[string, boolean]> = [];
    const stop = onChatBundle((key, result) => heard.push([key.channelId, result.ok]));
    await joinChatBundle(KEY, { deps: deps(store) });
    stop();
    await startChatBundle(KEY, { deps: deps(store) });
    expect(heard).toEqual([['c1', true]]);
  });
});

describe('plan cards start on the chat bundle', () => {
  it('the ids are the bundle shared plans plus every plan on its page, deduped', () => {
    const b = bundle({
      sharedPlanIds: ['p1', 'p2'],
      page: { rows: [row(1, { shared_plan_ids: ['p2', 'p3'] }), row(2)], hasMore: false },
    });
    expect(bundlePlanIds({ ok: true, data: b })).toEqual(['p1', 'p2', 'p3']);
    expect(bundlePlanIds({ ok: false, error: { code: 'unknown', message: 'x' } })).toEqual([]);
  });

  it('opens on the joined bundle or the next one heard for the same chat only', async () => {
    const opened: string[][] = [];
    const gate = { bundleReturned: (ids: readonly string[]) => void opened.push([...ids]) };
    const box: { listener: ((key: ChatKey, result: Result<ChatOpenBundle>) => void) | null } = {
      listener: null,
    };
    const stop = openPlansOnBundle(KEY, gate, {
      joinable: () => null,
      listen: (l) => {
        box.listener = l;
        return () => {
          box.listener = null;
        };
      },
    });
    const ok = (ids: string[]): Result<ChatOpenBundle> => ({
      ok: true,
      data: bundle({ sharedPlanIds: ids }),
    });
    box.listener?.({ ...KEY, channelId: 'other' }, ok(['x']));
    expect(opened).toEqual([]);
    box.listener?.(KEY, ok(['p1']));
    expect(opened).toEqual([['p1']]);
    stop();
    expect(box.listener).toBeNull();
    const joined = openPlansOnBundle(KEY, gate, {
      joinable: () => Promise.resolve(ok(['p9'])),
      listen: () => () => {},
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(opened).toEqual([['p1'], ['p9']]);
    joined();
  });
});

describe('applyOpenBundle: the page painted from the bundle alone', () => {
  it('rows, their reactions and quotes come in, nothing read', () => {
    const quotedRow = row(0, { body: 'the quote' });
    const reply = row(2, { reply_to_message_id: 'm0' });
    const fetched = [row(1), reply].map((r) => rowToThreadMessage(r, 'u1'));
    const next = applyOpenBundle([], {
      fetched,
      quoted: [rowToThreadMessage(quotedRow, 'u1')],
      reactions: new Map([['m1', [{ emoji: '👍', count: 2, mine: true }]]]),
      entries: [],
      currentUserId: 'u1',
    });
    expect(next.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(next[0]?.reactions).toEqual([{ emoji: '👍', count: 2, mine: true }]);
    expect(next[1]?.reply?.preview).toBe('the quote');
  });

  it('a quote the bundle could not return settles to the generic label', () => {
    const reply = rowToThreadMessage(row(2, { reply_to_message_id: 'gone' }), 'u1');
    const next = applyOpenBundle([], {
      fetched: [reply],
      quoted: [],
      reactions: new Map(),
      entries: [],
      currentUserId: 'u1',
    });
    expect(next[0]?.reply?.preview).toBe('Message');
  });
});
