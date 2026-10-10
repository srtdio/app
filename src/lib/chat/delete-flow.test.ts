import { describe, expect, it, vi } from 'vitest';
import type { Client, Result } from '@srtdio/rpc';

// use-chat-thread's import graph pulls the agora-chat browser SDK; mock it so
// importing the module in node never touches browser globals.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { runDelete, runEdit } from '@/lib/chat/delete-flow';
import {
  applyRevalidatedRows,
  editChannelType,
  editRunInput,
  newlyTombstoned,
  recheckLoaded,
  REVALIDATE_WINDOW_MS,
} from '@/lib/chat/use-chat-thread';
import { deleteOutcomeCopy } from '@/lib/chat/record';
import { pruneThreadSelection } from '@/lib/chat/forward';
import {
  markMessagesDeleted,
  parseLiveEvent,
  type ChatMessageRow,
  type ThreadMessage,
} from '@/lib/chat/thread';

function client(fail = false): { client: Client; rpc: ReturnType<typeof vi.fn> } {
  const rpc = vi.fn(() =>
    Promise.resolve(
      fail ? { data: null, error: { message: 'nope' } } : { data: null, error: null },
    ),
  );
  return { client: { rpc } as unknown as Client, rpc };
}

describe('runDelete', () => {
  const ids = Array.from({ length: 150 }, (_, i) => `m${i}`);

  it('records in chunks of 100, marks each chunk deleted locally and sends the delete cmd per chunk', async () => {
    const { client: db, rpc } = client();
    const markDeletedLocal = vi.fn();
    const signal = vi.fn(() => Promise.resolve({}));
    const result = await runDelete(
      { client: db, markDeletedLocal, signal, onSignalFailed: vi.fn() },
      { channelId: 'c', messageIds: ids, traceId: 't' },
    );
    expect(result).toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(markDeletedLocal.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      ids.slice(0, 100),
      ids.slice(100),
    ]);
    const exts = signal.mock.calls.map((c) => parseLiveEvent((c as unknown[])[0]));
    expect(exts).toEqual([
      { kind: 'delete', messageIds: ids.slice(0, 100) },
      { kind: 'delete', messageIds: ids.slice(100) },
    ]);
  });

  it('a failed record marks nothing, signals nothing and returns the proc message', async () => {
    const { client: db } = client(true);
    const markDeletedLocal = vi.fn();
    const signal = vi.fn(() => Promise.resolve({}));
    const result = await runDelete(
      { client: db, markDeletedLocal, signal, onSignalFailed: vi.fn() },
      { channelId: 'c', messageIds: ['a'], traceId: 't' },
    );
    expect(result).toEqual({ ok: false, message: 'nope', deleted: [] });
    expect(markDeletedLocal).not.toHaveBeenCalled();
    expect(signal).not.toHaveBeenCalled();
  });

  it('a failed signal never fails the delete', async () => {
    const { client: db } = client();
    const onSignalFailed = vi.fn();
    const result = await runDelete(
      {
        client: db,
        markDeletedLocal: vi.fn(),
        signal: () => Promise.reject(new Error('offline')),
        onSignalFailed,
      },
      { channelId: 'c', messageIds: ['a'], traceId: 't' },
    );
    await Promise.resolve();
    expect(result).toEqual({ ok: true });
    await vi.waitFor(() => expect(onSignalFailed).toHaveBeenCalledOnce());
  });
});

describe('D5: chunked delete, a later chunk fails', () => {
  const ids = Array.from({ length: 150 }, (_, i) => `m${i}`);
  const own = (id: string): ThreadMessage => ({
    id,
    senderUserId: 'me',
    body: `body ${id}`,
    createdAt: '2026-09-22T10:00:00Z',
    time: 1,
    provisionalTime: false,
    mine: true,
    attachments: [],
    sharedPostIds: [],
    sharedBriefIds: [],
    reply: null,
    state: 'sent',
    status: 'sent',
    reactions: [],
  });

  it('the first chunk is tombstoned, the failed ids stay selected, and the toast reads "Deleted 100 of 150"', async () => {
    let call = 0;
    const rpc = vi.fn(() => {
      call += 1;
      return Promise.resolve(
        call === 2
          ? { data: null, error: { message: 'network error' } }
          : { data: null, error: null },
      );
    });
    let thread = ids.map(own);
    const result = await runDelete(
      {
        client: { rpc } as unknown as Client,
        markDeletedLocal: (chunk) => {
          thread = markMessagesDeleted(thread, chunk);
        },
        signal: undefined,
        onSignalFailed: vi.fn(),
      },
      { channelId: 'c', messageIds: ids, traceId: 't' },
    );
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ ok: false, message: 'network error', deleted: ids.slice(0, 100) });
    // Committed chunk: tombstones. Failed chunk: untouched.
    expect(thread.slice(0, 100).every((m) => m.deleted === true)).toBe(true);
    expect(thread.slice(100).some((m) => m.deleted === true)).toBe(false);
    // The selection prunes the tombstones and keeps the failed chunk's ids.
    const kept = pruneThreadSelection(new Set(ids), thread);
    expect([...kept]).toEqual(ids.slice(100));
    const copy = result.ok
      ? ''
      : deleteOutcomeCopy(result.deleted.length, ids.length, result.message);
    expect(copy).toBe("Deleted 100 of 150. Couldn't delete the rest, try again");
  });

  it('N = 0 uses the mapped delete copy, never the raw error', () => {
    expect(deleteOutcomeCopy(0, 150, 'marked messages cannot be deleted')).toBe(
      "Marked messages can't be deleted",
    );
    expect(deleteOutcomeCopy(0, 3, 'TypeError: Failed to fetch')).toBe(
      "Couldn't delete, try again",
    );
  });
});

describe('runEdit', () => {
  const row = { id: 'm1', body: 'new', edited_at: '2026-09-22T10:05:00+00:00' };

  function editClient(result: { data: unknown; error: { message: string } | null }): {
    client: Client;
    rpc: ReturnType<typeof vi.fn>;
  } {
    const rpc = vi.fn(() => ({
      abortSignal: () => Promise.resolve(result),
    }));
    return { client: { rpc } as unknown as Client, rpc };
  }

  it('records first, then shows the returned row, then signals the edit event', async () => {
    const order: string[] = [];
    const { client, rpc } = editClient({ data: row, error: null });
    rpc.mockImplementation(() => {
      order.push('record');
      return { abortSignal: () => Promise.resolve({ data: row, error: null }) };
    });
    const applyLocal = vi.fn(() => order.push('local'));
    const signal = vi.fn(() => {
      order.push('signal');
      return Promise.resolve({});
    });
    const result = await runEdit(
      { client, applyLocal, signal, onSignalFailed: vi.fn() },
      { channelId: 'c', messageId: 'm1', body: 'new', traceId: 't' },
    );
    expect(result).toEqual({ ok: true });
    expect(order).toEqual(['record', 'local', 'signal']);
    expect(applyLocal).toHaveBeenCalledWith(row);
    expect(parseLiveEvent((signal.mock.calls[0] as unknown[])[0])).toEqual({
      kind: 'edit',
      messageId: 'm1',
      body: 'new',
      editedAt: '2026-09-22T10:05:00+00:00',
    });
  });

  it('a failed record changes nothing locally, signals nothing and returns the mapped copy', async () => {
    const { client } = editClient({ data: null, error: { message: 'edit window has closed' } });
    const applyLocal = vi.fn();
    const signal = vi.fn(() => Promise.resolve({}));
    const result = await runEdit(
      { client, applyLocal, signal, onSignalFailed: vi.fn() },
      { channelId: 'c', messageId: 'm1', body: 'new', traceId: 't' },
    );
    expect(result).toEqual({
      ok: false,
      message: 'Edit window has closed (15 min)',
      error: 'edit window has closed',
    });
    expect(applyLocal).not.toHaveBeenCalled();
    expect(signal).not.toHaveBeenCalled();
  });

  it('a failed signal never fails the edit', async () => {
    const { client } = editClient({ data: row, error: null });
    const onSignalFailed = vi.fn();
    const result = await runEdit(
      {
        client,
        applyLocal: vi.fn(),
        signal: () => Promise.reject(new Error('offline')),
        onSignalFailed,
      },
      { channelId: 'c', messageId: 'm1', body: 'new', traceId: 't' },
    );
    expect(result).toEqual({ ok: true });
    await vi.waitFor(() => expect(onSignalFailed).toHaveBeenCalledOnce());
  });
});

describe('D1: a reload that turns a visible row into a tombstone', () => {
  const row = (id: string, deleted = false): ThreadMessage => ({
    id,
    senderUserId: 'peer',
    body: deleted ? '' : `body ${id}`,
    createdAt: '2026-09-22T10:00:00Z',
    time: 1,
    provisionalTime: false,
    mine: false,
    attachments: [],
    sharedPostIds: [],
    sharedBriefIds: [],
    reply: null,
    state: 'sent',
    status: 'sent',
    reactions: [],
    ...(deleted ? { deleted: true } : {}),
  });

  it('reports only the rows that were on screen live and came back deleted', () => {
    const visible = [row('a'), row('b'), row('gone', true)];
    const fetched = [row('a', true), row('b'), row('gone', true), row('never-seen', true)];
    const reportDeleted = vi.fn();
    const turned = newlyTombstoned(visible, fetched);
    if (turned.length > 0) reportDeleted('c', turned);
    expect(reportDeleted).toHaveBeenCalledExactlyOnceWith('c', ['a']);
    expect(newlyTombstoned(visible, [row('a'), row('b')])).toEqual([]);
  });
});

describe('R2: catch-up rechecks loaded rows a missed delete or edit can touch', () => {
  const NOW = Date.parse('2026-09-29T12:00:00.000Z');
  const msg = (id: string, ageMs: number, over: Partial<ThreadMessage> = {}): ThreadMessage => ({
    id,
    senderUserId: 'p',
    body: 'original',
    createdAt: new Date(NOW - ageMs).toISOString(),
    time: NOW - ageMs,
    provisionalTime: false,
    mine: false,
    attachments: [],
    sharedPostIds: [],
    sharedBriefIds: [],
    reply: null,
    state: 'sent',
    status: 'sent',
    reactions: [],
    ...over,
  });
  const dbRow = (id: string, over: Partial<ChatMessageRow> = {}): ChatMessageRow => ({
    id,
    channel_id: 'c',
    workspace_id: 'w',
    sender_user_id: 'p',
    body: 'original',
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
    created_at: '2026-09-29T11:50:00.000000+00:00',
    edited_at: null,
    deleted_at: null,
    ...over,
  });
  const ok =
    (rows: ChatMessageRow[]) =>
    (ids: readonly string[]): Promise<Result<ChatMessageRow[]>> =>
      Promise.resolve({ ok: true, data: rows.filter((r) => ids.includes(r.id)) });

  it('reads once, only loaded rows within 30 min that are live and recorded', async () => {
    const list = [
      msg('old', REVALIDATE_WINDOW_MS + 1),
      msg('recent', 5 * 60_000),
      msg('edge', REVALIDATE_WINDOW_MS),
      msg('tomb', 60_000, { deleted: true }),
      msg('pending', 1000, { state: 'sending', provisionalTime: true }),
      msg('failed', 1000, { state: 'failed' }),
      msg('live-only', 1000, { provisionalTime: true }),
    ];
    const load = vi.fn(ok([]));
    await recheckLoaded(load, list, NOW, 'visible');
    expect(load).toHaveBeenCalledOnce();
    expect(load.mock.calls[0]?.[0]).toEqual(['recent', 'edge']);
  });

  it('no read when no loaded row qualifies', () => {
    const load = vi.fn(ok([]));
    expect(
      recheckLoaded(load, [msg('old', REVALIDATE_WINDOW_MS + 60_000)], NOW, 'connected'),
    ).toBeNull();
    expect(recheckLoaded(load, [], NOW, 'connected')).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it('a missed delete turns the row into a tombstone and is reported; a missed edit applies', () => {
    const list = [msg('a', 60_000), msg('b', 120_000), msg('c', 180_000)];
    const rows = [
      dbRow('a', { deleted_at: '2026-09-29T11:59:00+00:00', body: null }),
      dbRow('b', { body: 'edited', edited_at: '2026-09-29T11:58:30+00:00' }),
      dbRow('c'),
      dbRow('other-chat', { channel_id: 'x', deleted_at: '2026-09-29T11:59:00+00:00' }),
    ];
    const applied = applyRevalidatedRows(list, rows, 'c');
    expect(applied.deleted).toEqual(['a']);
    expect(applied.messages.find((m) => m.id === 'a')?.deleted).toBe(true);
    const b = applied.messages.find((m) => m.id === 'b');
    expect(b?.body).toBe('edited');
    expect(b?.editedAt).toBe('2026-09-29T11:58:30+00:00');
    expect(applied.messages.find((m) => m.id === 'c')).toBe(list[2]);
    const reportDeleted = vi.fn();
    if (applied.deleted.length > 0) reportDeleted('c', applied.deleted);
    expect(reportDeleted).toHaveBeenCalledExactlyOnceWith('c', ['a']);
  });

  it('S2: no recheck on the interval; recheck on connected and on foreground', () => {
    const list = [msg('recent', 5 * 60_000)];
    const load = vi.fn(ok([]));
    expect(recheckLoaded(load, list, NOW, 'interval')).toBeNull();
    expect(load).not.toHaveBeenCalled();
    for (const reason of ['connected', 'visible', 'online'] as const) {
      expect(recheckLoaded(load, list, NOW, reason)).not.toBeNull();
    }
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('S1: an older or equal edited_at is ignored; a newer one applies', () => {
    const list = [msg('b', 60_000, { body: 'second', editedAt: '2026-09-29T11:58:30.500+00:00' })];
    const older = dbRow('b', { body: 'first', edited_at: '2026-09-29T11:58:10+00:00' });
    expect(applyRevalidatedRows(list, [older], 'c').messages).toBe(list);
    const equal = dbRow('b', { body: 'stale', edited_at: '2026-09-29T11:58:30.500+00:00' });
    expect(applyRevalidatedRows(list, [equal], 'c').messages).toBe(list);
    const newer = dbRow('b', { body: 'third', edited_at: '2026-09-29T11:59:00+00:00' });
    const b = applyRevalidatedRows(list, [newer], 'c').messages.find((m) => m.id === 'b');
    expect(b?.body).toBe('third');
    expect(b?.editedAt).toBe('2026-09-29T11:59:00+00:00');
  });

  it('nothing changed on record: the same list, nothing reported', () => {
    const list = [msg('a', 60_000)];
    const applied = applyRevalidatedRows(list, [dbRow('a')], 'c');
    expect(applied.messages).toBe(list);
    expect(applied.deleted).toEqual([]);
  });
});

describe('runEdit mentions: every edit passes the complete current list', () => {
  const X = '44444444-4444-4444-8444-444444444444';
  const Y = '55555555-5555-4555-8555-555555555555';
  const Z = '66666666-6666-4666-8666-666666666666';

  async function editArgs(body: string): Promise<Record<string, unknown>> {
    const rpc = vi.fn(() => ({
      abortSignal: () =>
        Promise.resolve({ data: { id: 'm1', body, edited_at: 'now' }, error: null }),
    }));
    await runEdit(
      {
        client: { rpc } as unknown as Client,
        applyLocal: () => undefined,
        signal: undefined,
        onSignalFailed: () => undefined,
      },
      { channelId: 'c1', messageId: 'm1', body, traceId: 't' },
    );
    return (rpc.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
  }

  it('an edit with mentions passes all of them', async () => {
    expect((await editArgs(`@[${X}] and @[${Y}]`)).p_mentions).toEqual([X, Y]);
  });

  it('removing every mention passes an empty array (never omitted)', async () => {
    const args = await editArgs('no one now');
    expect(args).toHaveProperty('p_mentions');
    expect(args.p_mentions).toEqual([]);
  });

  it('adding a mention passes the union, removing one drops it', async () => {
    expect((await editArgs(`@[${Y}] and @[${Z}]`)).p_mentions).toEqual([Y, Z]);
  });
});

describe('H2 / A4 edit mentions', () => {
  const ANA = '44444444-4444-4444-8444-444444444444';
  const EX = '55555555-5555-4555-8555-555555555555';

  function rpcSequence(results: Array<{ data: unknown; error: { message: string } | null }>) {
    const queue = [...results];
    return vi.fn(() => ({
      abortSignal: () => Promise.resolve(queue.shift() ?? { data: null, error: null }),
    }));
  }

  function editDeps(
    rpc: ReturnType<typeof rpcSequence>,
    recheck?: () => Promise<Result<string[]>>,
  ) {
    return {
      client: { rpc } as unknown as Client,
      applyLocal: () => undefined,
      signal: undefined,
      onSignalFailed: () => undefined,
      ...(recheck !== undefined ? { recheckMentions: recheck } : {}),
    };
  }

  const argsOf = (rpc: ReturnType<typeof rpcSequence>, n: number): Record<string, unknown> =>
    (rpc.mock.calls[n] as unknown as [string, Record<string, unknown>])[1];

  it('H2 edit refused for a non-member re-reads once, drops only them and succeeds', async () => {
    const body = `@[${ANA}] @[${EX}]`;
    const rpc = rpcSequence([
      { data: null, error: { message: 'mentioned people must be in this chat' } },
      { data: { id: 'm1', body, edited_at: 'now' }, error: null },
    ]);
    const recheck = vi.fn(async () => ({ ok: true as const, data: [ANA] }));
    const result = await runEdit(editDeps(rpc, recheck), {
      channelId: 'c1',
      messageId: 'm1',
      body,
      traceId: 't',
    });
    expect(result.ok).toBe(true);
    expect(recheck).toHaveBeenCalledTimes(1);
    expect(argsOf(rpc, 0).p_mentions).toEqual([ANA, EX]);
    expect(argsOf(rpc, 1).p_mentions).toEqual([ANA]);
  });

  it('H2 edit refused and the re-read fails: edits without mentions, no failure', async () => {
    const body = `@[${ANA}]`;
    const rpc = rpcSequence([
      { data: null, error: { message: 'mentioned people must be in this chat' } },
      { data: { id: 'm1', body, edited_at: 'now' }, error: null },
    ]);
    const result = await runEdit(
      editDeps(rpc, async () => ({ ok: false, error: { code: 'unknown', message: 'down' } })),
      { channelId: 'c1', messageId: 'm1', body, traceId: 't' },
    );
    expect(result.ok).toBe(true);
    expect(argsOf(rpc, 1).p_mentions).toEqual([]);
  });

  it('J2 edit: second refusal steps down to no mentions and succeeds; "@[all]" in a DM edits without "all"', async () => {
    const body = `@[all] @[${ANA}]`;
    const rpc = rpcSequence([
      { data: null, error: { message: 'mentioned people must be in this chat' } },
      { data: null, error: { message: 'everyone mention works only in groups' } },
      { data: { id: 'm1', body, edited_at: 'now' }, error: null },
    ]);
    const recheck = vi.fn(async () => ({ ok: true as const, data: [ANA] }));
    const result = await runEdit(editDeps(rpc, recheck), {
      channelId: 'c1',
      messageId: 'm1',
      body,
      traceId: 't',
    });
    expect(result.ok).toBe(true);
    expect(recheck).toHaveBeenCalledTimes(1);
    expect(argsOf(rpc, 1).p_mentions).toEqual([ANA, 'all']);
    expect(argsOf(rpc, 2).p_mentions).toEqual([]);

    const dm = rpcSequence([{ data: { id: 'm1', body, edited_at: 'now' }, error: null }]);
    await runEdit(editDeps(dm), {
      channelId: 'c1',
      messageId: 'm1',
      body,
      traceId: 't',
      channelType: 'dm',
    });
    expect(argsOf(dm, 0).p_body).toBe(body);
    expect(argsOf(dm, 0).p_mentions).toEqual([ANA]);
  });

  it('B3 DM edit with "@[all]" plus a peer mention sends only the peer uuid', async () => {
    const body = `@[all] and @[${ANA}]`;
    // What use-chat-thread's editMessage derives from the open chat's target.
    const channelType = editChannelType({ targetId: 'peer', chatType: 'singleChat' });
    expect(channelType).toBe('dm');
    const dm = rpcSequence([{ data: { id: 'm1', body, edited_at: 'now' }, error: null }]);
    const result = await runEdit(editDeps(dm), {
      channelId: 'c1',
      messageId: 'm1',
      body,
      traceId: 't',
      ...(channelType !== undefined ? { channelType } : {}),
    });
    expect(result.ok).toBe(true);
    expect(dm).toHaveBeenCalledTimes(1);
    expect(argsOf(dm, 0).p_body).toBe(body);
    expect(argsOf(dm, 0).p_mentions).toEqual([ANA]);
    // A group keeps "all"; an unknown target leaves the type unset.
    expect(editChannelType({ targetId: 'g', chatType: 'groupChat' })).toBe('group');
    expect(editChannelType(null)).toBeUndefined();
  });

  it('W2 editRunInput (what editMessage hands runEdit): DM, group and null targets', async () => {
    const base = { channelId: 'c1', messageId: 'm1', body: `@[all] and @[${ANA}]`, traceId: 't' };
    const dmInput = editRunInput({ ...base, target: { targetId: 'peer', chatType: 'singleChat' } });
    expect(dmInput).toEqual({ ...base, channelType: 'dm' });
    expect(editRunInput({ ...base, target: { targetId: 'g', chatType: 'groupChat' } })).toEqual({
      ...base,
      channelType: 'group',
    });
    const none = editRunInput({ ...base, target: null });
    expect(none).toEqual(base);
    expect('channelType' in none).toBe(false);
    // The DM input edits without "all", in one call.
    const dm = rpcSequence([
      { data: { id: 'm1', body: base.body, edited_at: 'now' }, error: null },
    ]);
    await runEdit(editDeps(dm), dmInput);
    expect(dm).toHaveBeenCalledTimes(1);
    expect(argsOf(dm, 0).p_mentions).toEqual([ANA]);
  });

  it('W3 DM edit with a null target, "@[all]" plus a peer mention: final p_mentions keeps the peer uuid', async () => {
    const body = `@[all] and @[${ANA}]`;
    const rpc = rpcSequence([
      { data: null, error: { message: 'everyone mention works only in groups' } },
      { data: { id: 'm1', body, edited_at: 'now' }, error: null },
    ]);
    const recheck = vi.fn(async () => ({ ok: true as const, data: [ANA] }));
    const result = await runEdit(
      editDeps(rpc, recheck),
      editRunInput({ channelId: 'c1', messageId: 'm1', body, traceId: 't', target: null }),
    );
    expect(result.ok).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(argsOf(rpc, 0).p_mentions).toEqual([ANA, 'all']);
    // "all" drops first; the peer stays, with no re-read needed.
    expect(argsOf(rpc, 1).p_mentions).toEqual([ANA]);
    expect(recheck).not.toHaveBeenCalled();
  });

  it('A4 edit passes "all" while the token is present and omits it once removed', async () => {
    const withAll = rpcSequence([{ data: { id: 'm1', body: 'x', edited_at: 'now' }, error: null }]);
    await runEdit(editDeps(withAll), {
      channelId: 'c1',
      messageId: 'm1',
      body: `@[all] and @[${ANA}]`,
      traceId: 't',
    });
    expect(argsOf(withAll, 0).p_mentions).toEqual([ANA, 'all']);
    const removed = rpcSequence([{ data: { id: 'm1', body: 'x', edited_at: 'now' }, error: null }]);
    await runEdit(editDeps(removed), {
      channelId: 'c1',
      messageId: 'm1',
      body: `just @[${ANA}]`,
      traceId: 't',
    });
    expect(argsOf(removed, 0).p_mentions).toEqual([ANA]);
  });
});
