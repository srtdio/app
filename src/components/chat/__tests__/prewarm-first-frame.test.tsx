// @vitest-environment jsdom
// B2: a pre-warmed chat's first frame is its rows, never the skeleton. The
// pre-warm kept the page; the tap takes its bundle and, with it, the open's
// scheduled rows and marks; the names come from the held members in the tap's
// own commit; and the open hold (the plan bundles, the ticker) is a cold
// open's only. So the thread's first commit already has the rows, and none
// of the parts that paint the skeleton (the page, the names, the scheduled
// rows, the open hold) is waiting. A cold open still paints its skeleton, and
// every guard (a due scheduled row, names the held members cannot answer) is
// unchanged.
import { act, useLayoutEffect, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client, Result } from '@srtdio/rpc';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { prewarmChats, useChatThread } from '@/lib/chat/use-chat-thread';
import { createOpenCache, type ChatKey, type OpenCache } from '@/lib/chat/open-cache';
import { joinChatBundle, type ChatBundleDeps } from '@/lib/chat/open-bundle';
import type { ChatOpenBundle } from '@/lib/chat/history';
import type { ChatMessageRow } from '@/lib/chat/thread';
import type { ChannelOutbox } from '@/lib/chat/chat-store';
import type { ScheduledRow } from '@/lib/chat/scheduled';
import type { MentionProfile } from '@/lib/chat-reads';
import { chatThreadLoading, heldOpenNames } from '@/components/chat/ChatConnected';
import { openHoldApplies } from '@/components/chat/MessageThread';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ME = '11111111-1111-4111-8111-111111111111';
const PEER = '22222222-2222-4222-8222-222222222222';
const WS = 'ws-1';
const CHANNEL = 'dm__ws-1__a__b';
const KEY: ChatKey = { userId: ME, workspaceId: WS, channelId: CHANNEL };
const ROWS = 12;

function row(i: number): ChatMessageRow {
  return {
    id: `m-${String(i).padStart(4, '0')}`,
    channel_id: CHANNEL,
    workspace_id: WS,
    sender_user_id: i % 2 === 0 ? ME : PEER,
    body: `message ${i}`,
    mentions: null,
    attachment_asset_ids: null,
    shared_post_ids: null,
    shared_brief_ids: null,
    shared_plan_ids: null,
    reply_to_message_id: null,
    thread_root_message_id: null,
    forwarded_from_message_id: null,
    attachment_meta: null,
    agora_event_id: null,
    created_at: new Date(Date.UTC(2026, 9, 25, 10, 0, i)).toISOString(),
    edited_at: null,
    deleted_at: null,
    removed_files: {},
  };
}

function scheduledAt(sendAt: string): ScheduledRow {
  return {
    id: 's-1',
    channel_id: CHANNEL,
    workspace_id: WS,
    sender_user_id: ME,
    body: 'later',
    mentions: null,
    attachment_asset_ids: null,
    attachment_meta: null,
    shared_post_ids: null,
    shared_brief_ids: null,
    reply_to_message_id: null,
    send_at: sendAt,
    sent_at: null,
    status: 'scheduled',
    failure_reason: null,
    created_at: '2026-10-25T11:00:00.000Z',
    updated_at: '2026-10-25T11:00:00.000Z',
  } as unknown as ScheduledRow;
}

function bundle(scheduled: ScheduledRow[] = []): ChatOpenBundle {
  return {
    serverNow: '2026-10-25T12:00:00.000Z',
    page: { rows: Array.from({ length: ROWS }, (_, i) => row(i)), hasMore: false },
    quoted: [],
    reactions: [],
    readPositions: { rows: [], times: new Map() },
    replyCounts: new Map(),
    marks: [],
    scheduled,
    openPosts: [],
    openPostCount: 0,
    sharedPlanIds: ['plan-1'],
    openBriefs: [],
    openBriefCount: 0,
  };
}

/** A client that answers every read empty and counts them (the open must need none for its first frame). */
function countingClient(): { db: Client; reads: () => number } {
  let n = 0;
  const builder = (): unknown => {
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'is', 'in', 'or', 'gt', 'gte', 'lt', 'lte', 'order']) {
      b[m] = () => b;
    }
    for (const m of ['limit', 'abortSignal', 'maybeSingle']) b[m] = () => b;
    b.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(resolve);
    return b;
  };
  const db = {
    from: () => {
      n += 1;
      return builder();
    },
    rpc: () => {
      n += 1;
      return Promise.resolve({ data: null, error: null });
    },
  } as unknown as Client;
  return { db, reads: () => n };
}

const OUTBOX: ChannelOutbox = {
  entries: () => [],
  enqueue: () => {},
  retry: () => {},
  settle: () => {},
  cancel: () => false,
  subscribe: () => () => {},
  messagesDeleted: () => {},
};

interface Commit {
  rows: number;
  loading: boolean;
  reads: string;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let commits: Commit[] = [];

function Probe(props: { db: Client; memory: OpenCache }): ReactElement {
  const thread = useChatThread({
    client: null,
    status: 'connected',
    channelId: CHANNEL,
    target: null,
    currentUserId: ME,
    peerUserId: PEER,
    outbox: OUTBOX,
    db: props.db,
    workspaceId: WS,
    memory: props.memory,
  });
  // Each commit as the screen gets it (the first is the first frame).
  useLayoutEffect(() => {
    commits.push({
      rows: thread.messages.length,
      loading: thread.loading,
      reads: thread.readState.status,
    });
  });
  return <span />;
}

function mount(db: Client, memory: OpenCache): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(<Probe db={db} memory={memory} />);
  });
}

async function prewarm(memory: OpenCache, warm: ChatOpenBundle): Promise<number> {
  return prewarmChats([KEY], {
    store: memory,
    read: () => Promise.resolve({ ok: true, data: warm }),
    saveData: () => false,
    current: () => true,
  });
}

/** The tap's kickoff (startChatOpen's bundle) over a read that must not run. */
function tapDeps(memory: OpenCache): ChatBundleDeps & { asked: () => number } {
  let asked = 0;
  return {
    asked: () => asked,
    store: memory,
    read: () => {
      asked += 1;
      return Promise.resolve<Result<ChatOpenBundle>>({ ok: true, data: bundle() });
    },
    share: (_userId, _workspaceId, _what, load) => load(),
    traceId: () => 'trace-tap',
  };
}

/** The held members answer every id (both people are current members). */
function heldMembers(ids: readonly string[]): MentionProfile[] {
  return ids.map((userId) => ({
    userId,
    displayName: userId === ME ? 'Me' : 'Peer',
    avatarUrl: null,
    username: null,
    member: true,
  }));
}

/** Whether the thread shows the skeleton for this first commit (ChatConnected + MessageThread). */
function skeletonOn(input: {
  commit: Commit;
  namesReady: boolean;
  scheduledSettled: boolean;
  keptOpen: boolean;
}): boolean {
  const threadLoading = chatThreadLoading({
    threadCurrent: true,
    notesFailed: false,
    pageLoading: input.commit.loading,
    namesReady: input.namesReady,
    scheduledSettled: input.scheduledSettled,
    notesOpen: false,
    notesStatusReady: false,
    notesReady: false,
    savedReady: true,
  });
  const pageLoading = threadLoading || input.commit.reads === 'loading';
  // The plan bundles and the ticker are never in the first commit.
  const openHeld = openHoldApplies({
    keptOpen: input.keptOpen,
    holdDone: false,
    partsSettled: false,
  });
  return pageLoading || openHeld;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-25T12:00:00.000Z'));
  commits = [];
});

afterEach(() => {
  vi.useRealTimers();
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('B2: a pre-warmed chat paints its rows in the first frame', () => {
  it('first commit: the rows, the cursors, the parts in hand, no skeleton, nothing read', async () => {
    const memory = createOpenCache();
    const { db, reads } = countingClient();
    expect(await prewarm(memory, bundle([scheduledAt('2026-10-25T18:00:00.000Z')]))).toBe(1);
    vi.setSystemTime(new Date('2026-10-25T12:00:10.000Z'));
    // The tap: its kickoff takes the pre-warm (nothing read) and its parts.
    const d = tapDeps(memory);
    void joinChatBundle(KEY, { deps: d });
    expect(d.asked()).toBe(0);
    const scheduled = memory.recallFresh(KEY, 'scheduled');
    expect(scheduled?.map((r) => r.id)).toEqual(['s-1']);
    expect(memory.recallFresh(KEY, 'marks')).toBeDefined();
    // The tap's names from the held members, in the same commit as the open.
    const named = heldOpenNames({
      page: memory.recall(KEY, 'thread'),
      peerUserId: PEER,
      held: new Map(),
      peek: heldMembers,
    });
    expect(named?.ids.sort()).toEqual([ME, PEER].sort());

    mount(db, memory);
    const first = commits[0];
    expect(first).toEqual({ rows: ROWS, loading: false, reads: 'ready' });
    expect(
      skeletonOn({
        commit: first as Commit,
        namesReady: named !== null,
        scheduledSettled: scheduled !== undefined,
        keptOpen: memory.recall(KEY, 'thread') !== undefined,
      }),
    ).toBe(false);
    // Every later commit keeps the rows (the open re-reads nothing).
    for (const c of commits) expect(c.rows).toBe(ROWS);
    expect(reads()).toBe(0);
  });

  it('the open hold is a cold open only: kept rows never wait on the plan bundles', () => {
    expect(openHoldApplies({ keptOpen: true, holdDone: false, partsSettled: false })).toBe(false);
    expect(openHoldApplies({ keptOpen: false, holdDone: false, partsSettled: false })).toBe(true);
    expect(openHoldApplies({ keptOpen: false, holdDone: false, partsSettled: true })).toBe(false);
    expect(openHoldApplies({ keptOpen: false, holdDone: true, partsSettled: false })).toBe(false);
  });

  it('a cold open (no page kept) still paints its skeleton first', () => {
    const memory = createOpenCache();
    const { db } = countingClient();
    mount(db, memory);
    const first = commits[0];
    expect(first?.loading).toBe(true);
    expect(
      skeletonOn({
        commit: first as Commit,
        namesReady: true,
        scheduledSettled: memory.recallFresh(KEY, 'scheduled') !== undefined,
        keptOpen: memory.recall(KEY, 'thread') !== undefined,
      }),
    ).toBe(true);
  });

  it('a scheduled row due since the pre-warm: not taken, its rows not remembered (the read runs)', async () => {
    const memory = createOpenCache();
    await prewarm(memory, bundle([scheduledAt('2026-10-25T12:00:20.000Z')]));
    vi.setSystemTime(new Date('2026-10-25T12:00:30.000Z'));
    const d = tapDeps(memory);
    // Not taken: the tap starts its own read (withReadTimeout runs it one
    // microtask later), and none of the pre-warm's parts is remembered.
    const read = joinChatBundle(KEY, { deps: d });
    expect(memory.recallFresh(KEY, 'scheduled')).toBeUndefined();
    await read;
    expect(d.asked()).toBe(1);
  });

  it('names the held members cannot answer: none seeded, the names read runs as before', async () => {
    const memory = createOpenCache();
    await prewarm(memory, bundle());
    const page = memory.recall(KEY, 'thread');
    expect(heldOpenNames({ page, peerUserId: PEER, held: new Map(), peek: () => null })).toBeNull();
    // Nothing needed (every name held already): nothing to seed.
    const held = new Map([
      [ME, {}],
      [PEER, {}],
    ]);
    expect(heldOpenNames({ page, peerUserId: PEER, held, peek: heldMembers })).toBeNull();
    // No remembered page: nothing to seed.
    expect(
      heldOpenNames({ page: undefined, peerUserId: PEER, held: new Map(), peek: heldMembers }),
    ).toBeNull();
  });
});
