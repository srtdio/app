// Chat remembers messages per chat: the page a thread leaves behind is the
// chat's one copy (open-cache), live events land on it while the chat is
// closed through the open thread's apply functions (thread.ts), and a reopen
// paints it at once, then revalidates (use-chat-thread.ts pure pieces).

import { describe, expect, it, vi } from 'vitest';

// The thread module reaches the agora-chat browser SDK through the message
// factory; mock it so the pure pieces import in node.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import type { Result } from '@srtdio/rpc';
import {
  OPEN_CACHE_LIMIT,
  REMEMBERED_MESSAGES_LIMIT,
  createOpenCache,
  forgetRememberedThread,
  forgetThreadsOutside,
  rememberRecordedSend,
  rememberedWindow,
  routeRememberedCmd,
  routeRememberedText,
  withOwnCursor,
  type ChatKey,
  type OpenCache,
  type RememberedLiveDeps,
  type RememberedThread,
} from '@/lib/chat/open-cache';
import { CATCH_UP_LIMIT, type HistoryPage } from '@/lib/chat/history';
import {
  applyLiveDelete,
  rowCursor,
  rowToThreadMessage,
  withOutboxBubbles,
  type ChatMessageRow,
  type MessageCursor,
  type MessageReaction,
  type ThreadMessage,
} from '@/lib/chat/thread';
import {
  applyReopenChecks,
  awaitingResolve,
  openingState,
  revalidateRemembered,
  sameReadPositions,
  unseenRows,
  type ReopenLoaders,
  type ReopenRead,
} from '@/lib/chat/use-chat-thread';
import type { OutboxEntry } from '@/lib/chat/chat-store';

const ME = '11111111-1111-4111-8111-111111111111';
const PEER = '22222222-2222-4222-8222-222222222222';
const WS = 'ws-1';
const OTHER_WS = 'ws-2';
const CHANNEL = 'dm__ws-1__a__b';
const A: ChatKey = { userId: ME, workspaceId: WS, channelId: CHANNEL };
const B: ChatKey = { userId: ME, workspaceId: WS, channelId: 'group__ws-1__g' };

function row(n: number, overrides: Partial<ChatMessageRow> = {}): ChatMessageRow {
  return {
    id: `m-${String(n).padStart(4, '0')}`,
    channel_id: CHANNEL,
    workspace_id: WS,
    sender_user_id: n % 2 === 0 ? ME : PEER,
    body: `body ${n}`,
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
    created_at: new Date(Date.UTC(2026, 9, 3, 9, 0, 0) + n * 1000).toISOString(),
    edited_at: null,
    deleted_at: null,
    ...overrides,
  };
}

const msg = (r: ChatMessageRow): ThreadMessage => rowToThreadMessage(r, ME);
const ok = <T>(data: T): Result<T> => ({ ok: true, data });

function page(
  rows: readonly ChatMessageRow[],
  extra: Partial<RememberedThread> = {},
): RememberedThread {
  const last = rows[rows.length - 1];
  return {
    rows: rows.map(msg),
    hasMore: false,
    through: last !== undefined ? rowCursor(last) : undefined,
    reads: null,
    unresolved: [],
    ...extra,
  };
}

function sending(id: string, createdMs: number): OutboxEntry {
  return {
    id,
    text: 'queued',
    local: { attachments: [], sharedPostIds: [], sharedBriefIds: [], reply: null },
    state: 'sending',
    createdMs,
  };
}

/** A store holding a closed, remembered chat A with rows 1..10. */
function held(rows = Array.from({ length: 10 }, (_, i) => row(i + 1))): {
  store: OpenCache;
  rows: ChatMessageRow[];
} {
  const store = createOpenCache();
  const owner = store.attach(A);
  owner.keep(page(rows));
  owner.release();
  return { store, rows };
}

function deps(
  store: OpenCache,
  record: Map<string, ChatMessageRow>,
  workspaceId = WS,
): RememberedLiveDeps & { verify: ReturnType<typeof vi.fn>; loadRow: ReturnType<typeof vi.fn> } {
  return {
    store,
    userId: ME,
    workspaceId,
    verify: vi.fn(async (id: string) => record.get(id) ?? null),
    loadRow: vi.fn(async (id: string) => record.get(id) ?? null),
  };
}

const cmdExt = (event: Record<string, unknown>, ws: string | null = WS): Record<string, unknown> =>
  ws === null ? event : { ...event, sorted_workspace_id: ws };

const rowsOf = (store: OpenCache, key: ChatKey = A): ThreadMessage[] =>
  store.recall(key, 'thread')?.rows ?? [];

// ---------------------------------------------------------------------------

describe('remember on switch', () => {
  it('a thread leaving keeps its server rows, never a sending bubble', () => {
    const store = createOpenCache();
    const rows = [row(1), row(2), row(3)];
    const shown = withOutboxBubbles(rows.map(msg), [sending('q-1', Date.now())], ME);
    expect(shown.some((m) => m.id === 'q-1')).toBe(true);
    const owner = store.attach(A);
    const window = rememberedWindow(shown, false);
    owner.keep({ ...page(rows), rows: window.rows });
    owner.release();
    expect(rowsOf(store).map((m) => m.id)).toEqual(['m-0001', 'm-0002', 'm-0003']);
  });

  it('caps the window at 200, newest first kept, older ones flagged', () => {
    const rows = Array.from({ length: 250 }, (_, i) => msg(row(i + 1)));
    const window = rememberedWindow(rows, false);
    expect(window.rows).toHaveLength(REMEMBERED_MESSAGES_LIMIT);
    expect(window.rows[0]?.id).toBe('m-0051');
    expect(window.rows[window.rows.length - 1]?.id).toBe('m-0250');
    expect(window.hasMore).toBe(true);
    expect(rememberedWindow(rows.slice(0, 10), false).hasMore).toBe(false);
  });

  it('a write-back after the chat was forgotten while open is void', () => {
    const store = createOpenCache();
    const owner = store.attach(A);
    forgetRememberedThread(A, store);
    owner.keep(page([row(1)]));
    owner.release();
    expect(store.recall(A, 'thread')).toBeUndefined();
  });

  it('remembers at most OPEN_CACHE_LIMIT chats (least recently opened goes)', () => {
    const store = createOpenCache();
    for (let i = 0; i <= OPEN_CACHE_LIMIT; i += 1) {
      const owner = store.attach({ ...A, channelId: `c${i}` });
      owner.keep(page([row(1)]));
      owner.release();
    }
    expect(store.holding('thread')).toHaveLength(OPEN_CACHE_LIMIT);
    expect(store.recall({ ...A, channelId: 'c0' }, 'thread')).toBeUndefined();
    expect(store.recall({ ...A, channelId: `c${OPEN_CACHE_LIMIT}` }, 'thread')).toBeDefined();
  });
});

describe('quotes left unresolved', () => {
  it('rows still waiting on a quote or root are kept pending for the next reopen', () => {
    const plain = msg(row(1));
    const quoted: ThreadMessage = {
      ...msg(row(2)),
      reply: { id: 'm-0099', authorUserId: PEER, preview: '' } as unknown as ThreadMessage['reply'],
    };
    const rooted: ThreadMessage = { ...msg(row(3)), threadRootId: 'm-0098' };
    expect(awaitingResolve([plain, quoted, rooted])).toEqual(['m-0002', 'm-0003']);
    expect(awaitingResolve([plain], new Set(['m-0001']))).toEqual(['m-0001']);
  });
});

describe('own sends recorded while closed', () => {
  it('land on the remembered rows (no bubble lost), without local previews', () => {
    const { store } = held();
    const sent: ThreadMessage = {
      ...msg(row(12, { sender_user_id: ME })),
      attachments: [
        {
          assetId: 'a-1',
          name: 'photo.png',
          mime: 'image/png',
          size: 10,
          local: { file: null, previewUrl: 'blob:local' },
        } as unknown as ThreadMessage['attachments'][number],
      ],
    };
    rememberRecordedSend(A, sent, store);
    const kept = rowsOf(store).find((m) => m.id === sent.id);
    expect(kept).toBeDefined();
    expect(kept?.attachments[0]?.local).toBeUndefined();
    // The window strips them too when a thread leaves.
    expect(rememberedWindow([sent], false).rows[0]?.attachments[0]?.local).toBeUndefined();
  });
});

describe('reopen paints the remembered page', () => {
  it('rows at once, not loading, cursors ready from the viewer own cursor', () => {
    const rows = [row(1), row(2), row(3)];
    const reads = withOwnCursor(
      { rows: [], times: new Map() },
      ME,
      msg(rows[1] as ChatMessageRow),
      'x',
    );
    const opening = openingState({
      channelId: CHANNEL,
      page: page(rows, { reads }),
      outbox: [],
      currentUserId: ME,
    });
    expect(opening.loading).toBe(false);
    expect(opening.messages.map((m) => m.id)).toEqual(['m-0001', 'm-0002', 'm-0003']);
    expect(opening.reads.status).toBe('ready');
    expect(opening.reads.open).toMatchObject({ kind: 'cursor', position: { id: 'm-0002' } });
  });

  it('a fresh open is the outbox alone, loading', () => {
    const opening = openingState({
      channelId: CHANNEL,
      page: undefined,
      outbox: [sending('q-1', Date.now())],
      currentUserId: ME,
    });
    expect(opening.loading).toBe(true);
    expect(opening.messages.map((m) => m.id)).toEqual(['q-1']);
    expect(opening.reads.status).toBe('loading');
  });

  it('an outbox bubble is laid on the remembered rows once, never lost or doubled', () => {
    const rows = [row(1), row(2)];
    const entry = sending('q-1', Date.now() + 60_000);
    const first = openingState({
      channelId: CHANNEL,
      page: page(rows),
      outbox: [entry],
      currentUserId: ME,
    });
    expect(first.messages.filter((m) => m.id === 'q-1')).toHaveLength(1);
    // Left again with the bubble on screen, then reopened: still exactly one.
    const kept = rememberedWindow(first.messages, false);
    const again = openingState({
      channelId: CHANNEL,
      page: { ...page(rows), rows: kept.rows },
      outbox: [entry],
      currentUserId: ME,
    });
    expect(again.messages.filter((m) => m.id === 'q-1')).toHaveLength(1);
    expect(again.messages).toHaveLength(3);
  });
});

describe('live events while closed', () => {
  it('a new message lands on the remembered rows (verified row only)', async () => {
    const { store } = held();
    const fresh = row(11);
    const d = deps(store, new Map([[fresh.id, fresh]]));
    await routeRememberedText(d, { channelId: CHANNEL, messageId: fresh.id, ext: cmdExt({}) });
    expect(
      rowsOf(store)
        .map((m) => m.id)
        .at(-1),
    ).toBe('m-0011');
    expect(store.recall(A, 'thread')?.unresolved).toEqual(['m-0011']);
    // An id with no readable row is dropped.
    await routeRememberedText(d, { channelId: CHANNEL, messageId: 'ghost', ext: cmdExt({}) });
    expect(rowsOf(store)).toHaveLength(11);
  });

  it('an edit re-reads its row and applies it; a delete makes a tombstone', async () => {
    const { store, rows } = held();
    const edited = {
      ...(rows[2] as ChatMessageRow),
      body: 'edited',
      edited_at: new Date().toISOString(),
    };
    const d = deps(store, new Map([[edited.id, edited]]));
    await routeRememberedCmd(d, {
      ext: cmdExt({
        sorted_event: 'edit',
        message_ids: [edited.id],
        body: 'x',
        edited_at: edited.edited_at,
      }),
      fromUserId: PEER,
    });
    expect(rowsOf(store).find((m) => m.id === edited.id)?.body).toBe('edited');
    expect(d.loadRow).toHaveBeenCalledTimes(1);
    const victim = rows[4] as ChatMessageRow;
    await routeRememberedCmd(d, {
      ext: cmdExt({ sorted_event: 'delete', message_ids: [victim.id] }),
      fromUserId: PEER,
    });
    expect(rowsOf(store).find((m) => m.id === victim.id)?.deleted).toBe(true);
  });

  it("a delete or edit for someone else's message is ignored", async () => {
    const { store, rows } = held();
    const mine = rows[1] as ChatMessageRow; // sent by ME
    const d = deps(store, new Map([[mine.id, { ...mine, edited_at: 'z' }]]));
    await routeRememberedCmd(d, {
      ext: cmdExt({ sorted_event: 'delete', message_ids: [mine.id] }),
      fromUserId: PEER,
    });
    await routeRememberedCmd(d, {
      ext: cmdExt({
        sorted_event: 'edit',
        message_ids: [mine.id],
        body: 'x',
        edited_at: new Date().toISOString(),
      }),
      fromUserId: PEER,
    });
    expect(rowsOf(store).find((m) => m.id === mine.id)?.deleted).not.toBe(true);
    expect(d.loadRow).not.toHaveBeenCalled();
  });

  it('a reaction add and remove land, mine on the viewer own other device', async () => {
    const { store, rows } = held();
    const target = (rows[0] as ChatMessageRow).id;
    const d = deps(store, new Map());
    const react = (op: 'add' | 'remove', from: string): Promise<void> =>
      routeRememberedCmd(d, {
        ext: cmdExt({ sorted_event: 'reaction', message_id: target, emoji: '👍', op }),
        fromUserId: from,
      });
    await react('add', PEER);
    await react('add', ME);
    expect(rowsOf(store).find((m) => m.id === target)?.reactions).toEqual([
      { emoji: '👍', count: 2, mine: true },
    ]);
    await react('remove', PEER);
    expect(rowsOf(store).find((m) => m.id === target)?.reactions).toEqual([
      { emoji: '👍', count: 1, mine: true },
    ]);
  });

  it('a peer read signal ticks own messages read', async () => {
    const { store, rows } = held();
    const d = deps(store, new Map());
    await routeRememberedCmd(d, {
      ext: cmdExt({
        sorted_event: 'read',
        channel_id: CHANNEL,
        message_id: (rows[5] as ChatMessageRow).id,
      }),
      fromUserId: PEER,
    });
    const own = rowsOf(store).filter((m) => m.mine);
    expect(
      own
        .filter((m) => m.time <= msg(rows[5] as ChatMessageRow).time)
        .every((m) => m.status === 'read'),
    ).toBe(true);
  });

  it('events stamped with another workspace are ignored', async () => {
    const { store, rows } = held();
    const before = store.recall(A, 'thread');
    const fresh = { ...row(11) };
    const d = deps(store, new Map([[fresh.id, fresh]]));
    await routeRememberedText(d, {
      channelId: CHANNEL,
      messageId: fresh.id,
      ext: cmdExt({}, OTHER_WS),
    });
    await routeRememberedCmd(d, {
      ext: cmdExt(
        { sorted_event: 'delete', message_ids: [(rows[0] as ChatMessageRow).id] },
        OTHER_WS,
      ),
      fromUserId: PEER,
    });
    // A command with no workspace stamp is not trusted for a closed chat either.
    await routeRememberedCmd(d, {
      ext: cmdExt({ sorted_event: 'delete', message_ids: [(rows[0] as ChatMessageRow).id] }, null),
      fromUserId: PEER,
    });
    // A verified row of another workspace never lands.
    const foreign = { ...row(12), workspace_id: OTHER_WS };
    const d2 = deps(store, new Map([[foreign.id, foreign]]));
    await routeRememberedText(d2, { channelId: CHANNEL, messageId: foreign.id, ext: {} });
    expect(store.recall(A, 'thread')).toBe(before);
    expect(d.verify).not.toHaveBeenCalled();
  });

  it('a chat a thread shows is the thread own: the router leaves it alone', async () => {
    const { store, rows } = held();
    const owner = store.attach(A);
    const d = deps(store, new Map());
    await routeRememberedCmd(d, {
      ext: cmdExt({ sorted_event: 'delete', message_ids: [(rows[0] as ChatMessageRow).id] }),
      fromUserId: PEER,
    });
    expect(rowsOf(store)[0]?.deleted).not.toBe(true);
    owner.release();
  });

  it('live rows past 200 keep the newest 200 and flag older ones', async () => {
    const start = Array.from({ length: REMEMBERED_MESSAGES_LIMIT }, (_, i) => row(i + 1));
    const { store } = held(start);
    const fresh = row(REMEMBERED_MESSAGES_LIMIT + 1);
    await routeRememberedText(deps(store, new Map([[fresh.id, fresh]])), {
      channelId: CHANNEL,
      messageId: fresh.id,
      ext: cmdExt({}),
    });
    const kept = store.recall(A, 'thread');
    expect(kept?.rows).toHaveLength(REMEMBERED_MESSAGES_LIMIT);
    expect(kept?.rows[0]?.id).toBe('m-0002');
    expect(kept?.hasMore).toBe(true);
  });

  it('the thread and the router apply a delete the same way', () => {
    const rows = [row(1), row(3)].map(msg);
    const out = applyLiveDelete(rows, { messageIds: ['m-0001', 'm-0003'], fromUserId: PEER });
    expect(out.deleted).toEqual(['m-0001', 'm-0003']);
    expect(applyLiveDelete(out.messages, { messageIds: ['m-0001'], fromUserId: ME }).messages).toBe(
      out.messages,
    );
  });
});

describe('catch-up on reopen', () => {
  const loaders = (
    record: ChatMessageRow[],
    reactions = new Map<string, MessageReaction[]>(),
  ): ReopenLoaders & {
    loadNewer: ReturnType<typeof vi.fn>;
    loadByIds: ReturnType<typeof vi.fn>;
  } => ({
    loadNewer: vi.fn(async (cursor: MessageCursor) =>
      ok(record.filter((r) => r.created_at > cursor.createdAt).slice(0, CATCH_UP_LIMIT)),
    ),
    loadLatest: vi.fn(async () =>
      ok<HistoryPage>({ rows: record.slice(-50), hasMore: record.length > 50 }),
    ),
    loadByIds: vi.fn(async (ids: readonly string[]) =>
      ok(record.filter((r) => ids.includes(r.id))),
    ),
    loadReactions: vi.fn(async () => ok(reactions)),
  });
  const signal = new AbortController().signal;

  it('same data: no state change (the same list, no new rows, same cursors)', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(i + 1));
    const remembered = page(rows);
    const read = await revalidateRemembered(loaders(rows), remembered, signal);
    expect(read.kind).toBe('read');
    const r = read as Extract<ReopenRead, { kind: 'read' }>;
    expect(applyReopenChecks(remembered.rows, r, CHANNEL).messages).toBe(remembered.rows);
    expect(unseenRows(remembered.rows, r.newer ?? [])).toEqual([]);
    const cursors = {
      rows: [{ userId: PEER, lastReadMessageId: 'm-0003', lastReadAt: 'a', readAt: 'r1' }],
      times: new Map([['m-0003', 3]]),
    };
    expect(
      sameReadPositions(cursors, { ...cursors, rows: [{ ...cursors.rows[0]!, lastReadAt: 'b' }] }),
    ).toBe(true);
  });

  it('a read_at-only change is a change (Seen shows it), on the same cursor message', () => {
    const cursors = {
      rows: [
        {
          userId: PEER,
          lastReadMessageId: 'm-0003',
          lastReadAt: '2026-10-02T09:01:00Z',
          readAt: '2026-10-02T09:05:00Z',
        },
      ],
      times: new Map([['m-0003', 3]]),
    };
    const later = { ...cursors, rows: [{ ...cursors.rows[0]!, readAt: '2026-10-02T11:30:00Z' }] };
    const none = { ...cursors, rows: [{ ...cursors.rows[0]!, readAt: null }] };
    expect(sameReadPositions(cursors, later)).toBe(false);
    expect(sameReadPositions(cursors, none)).toBe(false);
    expect(sameReadPositions(cursors, { ...cursors, rows: [{ ...cursors.rows[0]! }] })).toBe(true);
  });

  it('edited, deleted and new rows while away are all correct after reopen', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(i + 1));
    const remembered = page(rows);
    const now = new Date().toISOString();
    const record = rows.map((r) =>
      r.id === 'm-0003'
        ? { ...r, body: 'edited away', edited_at: now }
        : r.id === 'm-0005'
          ? { ...r, deleted_at: now }
          : r,
    );
    record.push(row(11), row(12));
    const read = (await revalidateRemembered(loaders(record), remembered, signal)) as Extract<
      ReopenRead,
      { kind: 'read' }
    >;
    const checked = applyReopenChecks(remembered.rows, read, CHANNEL);
    expect(checked.messages.find((m) => m.id === 'm-0003')?.body).toBe('edited away');
    expect(checked.messages.find((m) => m.id === 'm-0005')?.deleted).toBe(true);
    expect(checked.deleted).toEqual(['m-0005']);
    expect(unseenRows(checked.messages, read.newer ?? []).map((r) => r.id)).toEqual([
      'm-0011',
      'm-0012',
    ]);
    expect(read.through).toEqual(rowCursor(row(12)));
  });

  it('reads once each: forward, by ids (max 200, IN) and reactions', async () => {
    const rows = Array.from({ length: 250 }, (_, i) => row(i + 1));
    const l = loaders(rows);
    await revalidateRemembered(l, page(rows), signal);
    expect(l.loadNewer).toHaveBeenCalledTimes(1);
    expect(l.loadByIds).toHaveBeenCalledTimes(1);
    expect((l.loadByIds.mock.calls[0]?.[0] as string[]).length).toBe(CATCH_UP_LIMIT);
    expect(l.loadReactions).toHaveBeenCalledTimes(1);
  });

  it('more than one page of new rows drops the memory (a gap)', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(i + 1));
    const record = [...rows, ...Array.from({ length: CATCH_UP_LIMIT }, (_, i) => row(100 + i))];
    expect((await revalidateRemembered(loaders(record), page(rows), signal)).kind).toBe('gap');
    // An empty remembered chat whose latest page has more behind it: a gap too.
    const latest = Array.from({ length: 60 }, (_, i) => row(i + 1));
    expect((await revalidateRemembered(loaders(latest), page([]), signal)).kind).toBe('gap');
  });

  it('a failed read keeps what is shown', async () => {
    const rows = [row(1), row(2)];
    const failing: ReopenLoaders = {
      loadNewer: async () => ({ ok: false, error: { message: 'x' } }) as Result<ChatMessageRow[]>,
      loadLatest: async () => ({ ok: false, error: { message: 'x' } }) as Result<HistoryPage>,
      loadByIds: async () => ({ ok: false, error: { message: 'x' } }) as Result<ChatMessageRow[]>,
      loadReactions: async () =>
        ({ ok: false, error: { message: 'x' } }) as Result<Map<string, MessageReaction[]>>,
    };
    const remembered = page(rows);
    const read = (await revalidateRemembered(failing, remembered, signal)) as Extract<
      ReopenRead,
      { kind: 'read' }
    >;
    expect(read.newer).toBeNull();
    expect(applyReopenChecks(remembered.rows, read, CHANNEL).messages).toBe(remembered.rows);
  });
});

describe('dropping the remembered chat', () => {
  it('removed, left or unknown: a roster without it forgets it (notes kept)', () => {
    const { store } = held();
    const notes = { ...A, channelId: 'notes__x' };
    const owner = store.attach(notes);
    owner.keep(page([row(1)]));
    owner.release();
    forgetThreadsOutside(ME, WS, new Set(['other']), (id) => id.startsWith('notes__'), store);
    expect(store.recall(A, 'thread')).toBeUndefined();
    expect(store.recall(notes, 'thread')).toBeDefined();
  });

  it('cleared: forgotten', () => {
    const { store } = held();
    forgetRememberedThread(A, store);
    expect(store.recall(A, 'thread')).toBeUndefined();
  });

  it('sign-out, another user or another workspace: everything goes', () => {
    const { store } = held();
    const owner = store.attach(B);
    owner.keep(page([row(1)]));
    owner.release();
    expect(store.holding('thread')).toHaveLength(2);
    store.recall({ ...A, userId: 'someone-else' }, 'thread');
    expect(store.holding('thread')).toHaveLength(0);
    const again = held().store;
    again.recall({ ...A, workspaceId: OTHER_WS }, 'thread');
    expect(again.holding('thread')).toHaveLength(0);
    const third = held().store;
    third.clear();
    expect(third.holding('thread')).toHaveLength(0);
  });
});
