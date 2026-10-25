import { describe, expect, it, vi } from 'vitest';
import type { AgoraChat } from 'agora-chat';
import type { Client } from '@srtdio/rpc';

// The import graph may reach the agora-chat browser SDK; mock it so importing
// in node never touches browser globals (as delete-flow.test does).
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import {
  applyRemovedOverlay,
  canRemove,
  canRemoveFile,
  canRemoveSingleFile,
  createRemovedFilesStore,
  EMPTY_OVERLAY,
  FILES_REMOVED_EVENT_HANDLER_ID,
  isFileRemoved,
  removeFailureCopy,
  removeMediaAria,
  REMOVE_FAILED_TOAST,
  REMOVE_PHOTO_ARIA,
  REMOVE_REFUSED_TOAST,
  REMOVE_VIDEO_ARIA,
  removedCountsOf,
  removedFilesLabel,
  rereadRemovedRows,
  runRemoveFiles,
  subscribeFilesRemoved,
  type FilesRemovedConnection,
  type RemovedOverlay,
  type RemovedRow,
  type RemoveFileTarget,
} from '@/lib/chat/remove-files';
import { REMOVE_FILES_CHUNK_SIZE, removeFilesRecord } from '@/lib/chat/record';
import { filesRemovedEventExt, parseLiveEvent, type ThreadMessage } from '@/lib/chat/thread';
import { toAgoraUsername } from '@/lib/chat/agora-identity';

const ME = '11111111-1111-4111-8111-111111111111';
const PEER = '22222222-2222-4222-8222-222222222222';
const CHANNEL = 'group__ws__g1';

const NO_MARKS = { has: () => false };

function message(over: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id: 'm1',
    senderUserId: ME,
    body: 'caption',
    createdAt: '2026-10-25T10:00:00+00:00',
    time: Date.parse('2026-10-25T10:00:00Z'),
    provisionalTime: false,
    mine: true,
    attachments: [{ assetId: 'a1', name: 'one.jpg', mime: 'image/jpeg' }],
    sharedPostIds: [],
    sharedBriefIds: [],
    reply: null,
    state: 'sent',
    status: 'sent',
    reactions: [],
    ...over,
  };
}

/** An rpc mock: each call resolves with the next configured result (or ok). */
function rpcClient(results: ({ message: string } | null)[] = []): {
  client: Client;
  rpc: ReturnType<typeof vi.fn>;
} {
  let i = 0;
  const rpc = vi.fn(() => {
    const error = results[i] ?? null;
    i += 1;
    return Promise.resolve({ data: null, error });
  });
  return { client: { rpc } as unknown as Client, rpc };
}

describe('removedFilesLabel', () => {
  it('reads plurals per kind', () => {
    expect(removedFilesLabel({ photo: 1 })).toBe('1 photo removed');
    expect(removedFilesLabel({ photo: 3 })).toBe('3 photos removed');
    expect(removedFilesLabel({ video: 1 })).toBe('1 video removed');
    expect(removedFilesLabel({ video: 2 })).toBe('2 videos removed');
    expect(removedFilesLabel({ file: 1 })).toBe('File removed');
    expect(removedFilesLabel({ file: 2 })).toBe('2 files removed');
  });

  it('joins mixes with " and " in the order photo, video, file', () => {
    expect(removedFilesLabel({ photo: 1, file: 1 })).toBe('1 photo and 1 file removed');
    expect(removedFilesLabel({ file: 3, video: 1, photo: 2 })).toBe(
      '2 photos and 1 video and 3 files removed',
    );
  });

  it('is empty for no counts', () => {
    expect(removedFilesLabel({})).toBe('');
    expect(removedFilesLabel({ photo: 0, video: 0, file: 0 })).toBe('');
  });

  it('counts mimes the way the proc does', () => {
    expect(removedCountsOf(['image/png', 'video/mp4', 'application/pdf', 'image/heic'])).toEqual({
      photo: 2,
      video: 1,
      file: 1,
    });
  });
});

describe('who may remove', () => {
  it('canRemoveFile: own file ok; other, voice, marked, deleted and unrecorded refused', () => {
    const own = { id: 'm1', senderUserId: ME };
    const photo = { assetId: 'a1', mime: 'image/jpeg' };
    expect(canRemoveFile(own, photo, ME, NO_MARKS)).toBe(true);
    expect(canRemoveFile({ id: 'm1', senderUserId: PEER }, photo, ME, NO_MARKS)).toBe(false);
    expect(canRemoveFile(own, { assetId: 'a1', mime: 'audio/webm' }, ME, NO_MARKS)).toBe(false);
    expect(canRemoveFile(own, photo, ME, new Set(['m1']))).toBe(false);
    expect(canRemoveFile({ ...own, deleted: true }, photo, ME, NO_MARKS)).toBe(false);
    expect(canRemoveFile(own, { assetId: '', mime: 'image/jpeg' }, ME, NO_MARKS)).toBe(false);
    expect(canRemoveFile(own, photo, '', NO_MARKS)).toBe(false);
  });

  it('canRemove: needs one removable file on a sent message', () => {
    expect(canRemove(message(), ME, NO_MARKS)).toBe(true);
    expect(canRemove(message({ senderUserId: PEER, mine: false }), ME, NO_MARKS)).toBe(false);
    expect(canRemove(message({ state: 'sending' }), ME, NO_MARKS)).toBe(false);
    expect(
      canRemove(
        message({ attachments: [{ assetId: 'v1', name: 'note', mime: 'audio/mp4' }] }),
        ME,
        NO_MARKS,
      ),
    ).toBe(false);
    expect(canRemove(message({ attachments: [] }), ME, NO_MARKS)).toBe(false);
    expect(canRemove(message(), ME, new Set(['m1']))).toBe(false);
    expect(canRemove(message({ deleted: true }), ME, NO_MARKS)).toBe(false);
  });

  it('canRemoveSingleFile: exactly one removable file; an album of 2 is refused', () => {
    expect(canRemoveSingleFile(message(), ME, NO_MARKS)).toBe(true);
    const album = message({
      attachments: [
        { assetId: 'a1', name: 'one.jpg', mime: 'image/jpeg' },
        { assetId: 'a2', name: 'two.jpg', mime: 'image/jpeg' },
      ],
    });
    expect(canRemoveSingleFile(album, ME, NO_MARKS)).toBe(false);
    expect(canRemoveSingleFile(message({ senderUserId: PEER }), ME, NO_MARKS)).toBe(false);
  });

  it('removeMediaAria reads photo or video', () => {
    expect(removeMediaAria('image/png')).toBe(REMOVE_PHOTO_ARIA);
    expect(removeMediaAria('video/mp4')).toBe(REMOVE_VIDEO_ARIA);
    expect(REMOVE_PHOTO_ARIA).toBe('Remove photo');
    expect(REMOVE_VIDEO_ARIA).toBe('Remove video');
  });
});

describe('removeFailureCopy', () => {
  it('maps the proc refusals to the ownership toast and everything else to Try again', () => {
    expect(removeFailureCopy('only your own files can be removed')).toBe(REMOVE_REFUSED_TOAST);
    expect(removeFailureCopy('not a member of this chat')).toBe(REMOVE_REFUSED_TOAST);
    expect(removeFailureCopy('select between 1 and 100 files')).toBe(REMOVE_FAILED_TOAST);
    expect(removeFailureCopy('TypeError: fetch failed')).toBe(REMOVE_FAILED_TOAST);
    expect(REMOVE_REFUSED_TOAST).toBe("Couldn't remove. Only your own files can be removed.");
    expect(REMOVE_FAILED_TOAST).toBe("Couldn't remove. Try again.");
  });
});

describe('runRemoveFiles', () => {
  const files: RemoveFileTarget[] = [
    { messageId: 'm1', assetId: 'a1' },
    { messageId: 'm1', assetId: 'a2' },
    { messageId: 'm2', assetId: 'a1' },
  ];

  it('records, then purges the deduped asset ids and signals the message ids', async () => {
    const { client, rpc } = rpcClient();
    const purgeChat = vi.fn(() =>
      Promise.resolve({ ok: true as const, data: { removed: 2, freedBytes: 10 } }),
    );
    const signal = vi.fn(() => Promise.resolve({}));
    const result = await runRemoveFiles(
      { client, purgeChat, signal, onSignalFailed: vi.fn() },
      { channelId: CHANNEL, files, traceId: 't' },
    );
    expect(result).toEqual({ ok: true, removed: files });
    expect(rpc).toHaveBeenCalledWith('chat_message_remove_files', {
      p_channel_id: CHANNEL,
      p_message_ids: ['m1', 'm2'],
      p_asset_ids: ['a1', 'a2', 'a1'],
      p_trace_id: 't',
    });
    expect(purgeChat).toHaveBeenCalledWith(['a1', 'a2']);
    expect(signal).toHaveBeenCalledWith({
      sorted_event: 'files_removed',
      message_ids: ['m1', 'm2'],
    });
    expect(parseLiveEvent((signal.mock.calls[0] as unknown[])[0])).toEqual({
      kind: 'files_removed',
      messageIds: ['m1', 'm2'],
    });
  });

  it('does nothing for no files', async () => {
    const { client, rpc } = rpcClient();
    const result = await runRemoveFiles(
      { client, signal: undefined, onSignalFailed: vi.fn() },
      { channelId: CHANNEL, files: [], traceId: 't' },
    );
    expect(result).toEqual({ ok: true, removed: [] });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('a failed purge never fails the removal', async () => {
    const { client } = rpcClient();
    const onPurgeFailed = vi.fn();
    const result = await runRemoveFiles(
      {
        client,
        purgeChat: () => Promise.resolve({ ok: false as const, error: 'purge down' }),
        onPurgeFailed,
        signal: undefined,
        onSignalFailed: vi.fn(),
      },
      { channelId: CHANNEL, files, traceId: 't' },
    );
    expect(result.ok).toBe(true);
    expect(onPurgeFailed).toHaveBeenCalledWith('purge down');

    const thrown = vi.fn();
    const again = await runRemoveFiles(
      {
        client,
        purgeChat: () => Promise.reject(new Error('boom')),
        onPurgeFailed: thrown,
        signal: undefined,
        onSignalFailed: vi.fn(),
      },
      { channelId: CHANNEL, files, traceId: 't' },
    );
    expect(again.ok).toBe(true);
    expect(thrown).toHaveBeenCalledOnce();
  });

  it('a failed signal never fails the removal', async () => {
    const { client } = rpcClient();
    const onSignalFailed = vi.fn();
    const result = await runRemoveFiles(
      { client, signal: () => Promise.reject(new Error('offline')), onSignalFailed },
      { channelId: CHANNEL, files, traceId: 't' },
    );
    expect(result.ok).toBe(true);
    await vi.waitFor(() => expect(onSignalFailed).toHaveBeenCalledOnce());
  });

  it('a refused record returns the refusal toast and neither purges nor signals', async () => {
    const { client } = rpcClient([{ message: 'only your own files can be removed' }]);
    const purgeChat = vi.fn();
    const signal = vi.fn(() => Promise.resolve({}));
    const result = await runRemoveFiles(
      { client, purgeChat, signal, onSignalFailed: vi.fn() },
      { channelId: CHANNEL, files, traceId: 't' },
    );
    expect(result).toEqual({
      ok: false,
      removed: [],
      message: REMOVE_REFUSED_TOAST,
      error: 'only your own files can be removed',
    });
    expect(purgeChat).not.toHaveBeenCalled();
    expect(signal).not.toHaveBeenCalled();
  });
});

describe('removeFilesRecord chunking', () => {
  const many: RemoveFileTarget[] = Array.from({ length: 150 }, (_, i) => ({
    messageId: `m${i % 3}`,
    assetId: `a${i}`,
  }));

  it('calls the proc once per 100 asset ids, in order, naming each chunk\'s messages', async () => {
    expect(REMOVE_FILES_CHUNK_SIZE).toBe(100);
    const { client, rpc } = rpcClient();
    const onChunkRemoved = vi.fn();
    const result = await removeFilesRecord({
      client,
      channelId: CHANNEL,
      files: many,
      traceId: 't',
      onChunkRemoved,
    });
    expect(result).toEqual({ ok: true, removed: many });
    expect(rpc).toHaveBeenCalledTimes(2);
    const args = rpc.mock.calls.map((c) => (c as unknown[])[1] as Record<string, unknown>);
    expect(args[0]?.p_asset_ids).toEqual(many.slice(0, 100).map((f) => f.assetId));
    expect(args[1]?.p_asset_ids).toEqual(many.slice(100).map((f) => f.assetId));
    expect(args[0]?.p_message_ids).toEqual(['m0', 'm1', 'm2']);
    expect(onChunkRemoved).toHaveBeenCalledTimes(2);
  });

  it('stops at the first refused chunk and reports the accepted ones', async () => {
    const { client, rpc } = rpcClient([null, { message: 'only your own files can be removed' }]);
    const result = await removeFilesRecord({
      client,
      channelId: CHANNEL,
      files: [...many, ...many.slice(0, 60)],
      traceId: 't',
    });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      ok: false,
      removed: many.slice(0, 100),
      message: 'only your own files can be removed',
    });
  });

  it('runRemoveFiles purges and signals only the accepted chunk on a partial refusal', async () => {
    const { client } = rpcClient([null, { message: 'nope' }]);
    const purgeChat = vi.fn(() =>
      Promise.resolve({ ok: true as const, data: { removed: 100, freedBytes: 1 } }),
    );
    const result = await runRemoveFiles(
      { client, purgeChat, signal: undefined, onSignalFailed: vi.fn() },
      { channelId: CHANNEL, files: many, traceId: 't' },
    );
    expect(result).toMatchObject({ ok: false, message: REMOVE_FAILED_TOAST, error: 'nope' });
    expect(result.removed).toHaveLength(100);
    expect(purgeChat).toHaveBeenCalledWith(many.slice(0, 100).map((f) => f.assetId));
  });
});

function removedRow(over: Partial<RemovedRow> = {}): RemovedRow {
  return {
    id: 'm1',
    channel_id: CHANNEL,
    sender_user_id: ME,
    attachment_asset_ids: ['a2'],
    removed_files: { photo: 1 },
    deleted_at: null,
    ...over,
  };
}

describe('the overlay store', () => {
  it('add hides files, its undo brings back exactly those files', () => {
    const store = createRemovedFilesStore();
    const listener = vi.fn();
    store.subscribe(listener);
    expect(store.get(CHANNEL)).toBe(EMPTY_OVERLAY);
    const undoA = store.add(CHANNEL, [{ messageId: 'm1', assetId: 'a1' }]);
    const undoB = store.add(CHANNEL, [
      { messageId: 'm1', assetId: 'a2' },
      { messageId: 'm2', assetId: 'b1' },
    ]);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(isFileRemoved(store.get(CHANNEL), 'm1', 'a1')).toBe(true);
    expect(isFileRemoved(store.get(CHANNEL), 'm1', 'a2')).toBe(true);
    expect(isFileRemoved(store.get(CHANNEL), 'm2', 'b1')).toBe(true);
    expect(isFileRemoved(store.get('other'), 'm1', 'a1')).toBe(false);

    undoB();
    expect(isFileRemoved(store.get(CHANNEL), 'm1', 'a1')).toBe(true);
    expect(isFileRemoved(store.get(CHANNEL), 'm1', 'a2')).toBe(false);
    expect(store.get(CHANNEL).pending.has('m2')).toBe(false);
    undoA();
    expect(store.get(CHANNEL).pending.size).toBe(0);
  });

  it('snapshots are immutable and add of nothing changes nothing', () => {
    const store = createRemovedFilesStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.add(CHANNEL, [])();
    expect(listener).not.toHaveBeenCalled();
    store.add(CHANNEL, [{ messageId: 'm1', assetId: 'a1' }]);
    const before = store.get(CHANNEL);
    store.add(CHANNEL, [{ messageId: 'm1', assetId: 'a2' }]);
    expect(before.pending.get('m1')?.has('a2')).toBe(false);
    expect(store.get(CHANNEL)).not.toBe(before);
  });

  it('applyRows keeps the re-read rows by id; reset clears everything', () => {
    const store = createRemovedFilesStore();
    store.applyRows(CHANNEL, [removedRow()]);
    store.applyRows(CHANNEL, [removedRow({ attachment_asset_ids: null })]);
    const overlay = store.get(CHANNEL);
    expect(overlay.rows.size).toBe(1);
    expect(isFileRemoved(overlay, 'm1', 'a2')).toBe(true);
    const listener = vi.fn();
    store.subscribe(listener);
    store.applyRows(CHANNEL, []);
    expect(listener).not.toHaveBeenCalled();
    store.reset();
    expect(store.get(CHANNEL)).toBe(EMPTY_OVERLAY);
  });
});

describe('isFileRemoved', () => {
  it('reads pending removals and re-read rows', () => {
    const overlay: RemovedOverlay = {
      pending: new Map([['m1', new Set(['a1'])]]),
      rows: new Map([
        ['m2', removedRow({ id: 'm2', attachment_asset_ids: ['b2'] })],
        ['m3', removedRow({ id: 'm3', deleted_at: '2026-10-25T10:00:00Z' })],
      ]),
    };
    expect(isFileRemoved(overlay, 'm1', 'a1')).toBe(true);
    expect(isFileRemoved(overlay, 'm1', 'a2')).toBe(false);
    expect(isFileRemoved(overlay, 'm2', 'b1')).toBe(true);
    expect(isFileRemoved(overlay, 'm2', 'b2')).toBe(false);
    expect(isFileRemoved(overlay, 'm3', 'b2')).toBe(true);
    expect(isFileRemoved(overlay, 'm9', 'x')).toBe(false);
    expect(isFileRemoved(EMPTY_OVERLAY, 'm1', 'a1')).toBe(false);
  });
});

describe('applyRemovedOverlay', () => {
  const mixed = message({
    attachments: [
      { assetId: 'a1', name: 'one.jpg', mime: 'image/jpeg' },
      { assetId: 'a2', name: 'two.jpg', mime: 'image/jpeg' },
      { assetId: 'v1', name: 'clip.mp4', mime: 'video/mp4' },
      { assetId: 'f1', name: 'brief.pdf', mime: 'application/pdf' },
    ],
  });

  it('returns the same list for an empty overlay', () => {
    const list = [mixed];
    expect(applyRemovedOverlay(list, EMPTY_OVERLAY)).toBe(list);
  });

  it('a pending removal drops the files and counts their kinds', () => {
    const overlay: RemovedOverlay = {
      pending: new Map([['m1', new Set(['a1', 'v1', 'f1'])]]),
      rows: new Map(),
    };
    const [out] = applyRemovedOverlay([mixed], overlay);
    expect(out?.attachments.map((a) => a.assetId)).toEqual(['a2']);
    expect(out?.removedFiles).toEqual({ photo: 1, video: 1, file: 1 });
    expect(out?.body).toBe('caption');
  });

  it('is idempotent on a list that already carries the removal', () => {
    const overlay: RemovedOverlay = {
      pending: new Map([['m1', new Set(['a1'])]]),
      rows: new Map(),
    };
    const once = applyRemovedOverlay([mixed], overlay);
    const twice = applyRemovedOverlay(once, overlay);
    expect(twice).toBe(once);
    expect(twice[0]?.removedFiles).toEqual({ photo: 1, video: 0, file: 0 });
  });

  it('a pending removal of the last file with no text leaves a tombstone', () => {
    const lone = message({ body: '' });
    const overlay: RemovedOverlay = {
      pending: new Map([['m1', new Set(['a1'])]]),
      rows: new Map(),
    };
    expect(applyRemovedOverlay([lone], overlay)[0]?.deleted).toBe(true);
  });

  it('a re-read row with deleted_at turns the message into a tombstone', () => {
    const overlay: RemovedOverlay = {
      pending: new Map(),
      rows: new Map([['m1', removedRow({ deleted_at: '2026-10-25T10:00:00Z' })]]),
    };
    const [out] = applyRemovedOverlay([mixed], overlay);
    expect(out?.deleted).toBe(true);
  });

  it('a re-read row overrides the attachments and the removed counts', () => {
    const overlay: RemovedOverlay = {
      pending: new Map(),
      rows: new Map([
        [
          'm1',
          removedRow({ attachment_asset_ids: ['a2', 'f1'], removed_files: { photo: 1, video: 1 } }),
        ],
      ]),
    };
    const [out] = applyRemovedOverlay([mixed, message({ id: 'other' })], overlay);
    expect(out?.attachments.map((a) => a.assetId)).toEqual(['a2', 'f1']);
    expect(out?.removedFiles).toEqual({ photo: 1, video: 1, file: 0 });
    const again = applyRemovedOverlay([out as ThreadMessage], overlay);
    expect(again[0]?.attachments.map((a) => a.assetId)).toEqual(['a2', 'f1']);
  });

  it('leaves an already deleted message and unrelated messages alone', () => {
    const gone = message({ id: 'm1', deleted: true, attachments: [] });
    const list = [gone];
    const overlay: RemovedOverlay = {
      pending: new Map(),
      rows: new Map([['m1', removedRow({ attachment_asset_ids: [] })]]),
    };
    expect(applyRemovedOverlay(list, overlay)).toBe(list);
  });
});

describe('subscribeFilesRemoved', () => {
  function connection(): {
    conn: FilesRemovedConnection;
    handler: () => AgoraChat.EventHandlerType | undefined;
  } {
    const handlers: Record<string, AgoraChat.EventHandlerType> = {};
    const conn: FilesRemovedConnection = {
      addEventHandler: vi.fn((id: string, h: AgoraChat.EventHandlerType) => {
        handlers[id] = h;
      }),
      removeEventHandler: vi.fn(),
    };
    return { conn, handler: () => handlers[FILES_REMOVED_EVENT_HANDLER_ID] };
  }

  function cmd(over: Partial<AgoraChat.CmdMsgBody>): AgoraChat.CmdMsgBody {
    return {
      id: 'agora-cmd',
      type: 'cmd',
      chatType: 'groupChat',
      to: 'agora-group-1',
      from: toAgoraUsername(PEER),
      action: 'sorted_signal',
      time: 1,
      ...over,
    } as AgoraChat.CmdMsgBody;
  }

  it('parses the cmd, maps the sender and tears down its own handler', () => {
    const { conn, handler } = connection();
    const onRemoved = vi.fn();
    const teardown = subscribeFilesRemoved(conn, onRemoved);
    handler()?.onCmdMessage?.(cmd({ ext: filesRemovedEventExt({ messageIds: ['m1', 'm2'] }) }));
    expect(onRemoved).toHaveBeenCalledWith({ messageIds: ['m1', 'm2'], fromUserId: PEER });
    teardown();
    expect(conn.removeEventHandler).toHaveBeenCalledWith(FILES_REMOVED_EVENT_HANDLER_ID);
  });

  it('ignores other signals, empty ids and unmappable senders', () => {
    const { conn, handler } = connection();
    const onRemoved = vi.fn();
    subscribeFilesRemoved(conn, onRemoved);
    handler()?.onCmdMessage?.(cmd({ ext: { sorted_event: 'delete', message_ids: ['m1'] } }));
    handler()?.onCmdMessage?.(cmd({ ext: { sorted_event: 'files_removed', message_ids: [] } }));
    handler()?.onCmdMessage?.(
      cmd({ from: 'nobody', ext: filesRemovedEventExt({ messageIds: ['m1'] }) }),
    );
    handler()?.onCmdMessage?.(cmd({ action: 'typing' }));
    expect(onRemoved).not.toHaveBeenCalled();
  });
});

describe('rereadRemovedRows', () => {
  // A recording PostgREST-ish builder (as history.test): chained methods return
  // self; awaiting yields the configured result.
  function makeClient(result: { data: unknown; error: { message: string } | null }): {
    client: Client;
    calls: { method: string; args: unknown[] }[];
  } {
    const calls: { method: string; args: unknown[] }[] = [];
    const b: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'is', 'in', 'or', 'order', 'limit', 'abortSignal']) {
      b[method] = (...args: unknown[]) => {
        calls.push({ method, args });
        return b;
      };
    }
    b.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
    const from = vi.fn((table: string) => {
      calls.push({ method: 'from', args: [table] });
      return b;
    });
    return { client: { from } as unknown as Client, calls };
  }

  it('keeps only rows of this channel sent by the signal sender', async () => {
    const rows = [
      removedRow({ id: 'm1', sender_user_id: PEER }),
      removedRow({ id: 'm2', sender_user_id: ME }),
      removedRow({ id: 'm3', sender_user_id: PEER, channel_id: 'group__ws__other' }),
    ];
    const { client, calls } = makeClient({ data: rows, error: null });
    const result = await rereadRemovedRows(client, {
      channelId: CHANNEL,
      messageIds: ['m1', 'm2', 'm3'],
      fromUserId: PEER,
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.data.map((r) => r.id)).toEqual(['m1']);
    expect(calls.find((c) => c.method === 'from')?.args).toEqual(['chat_messages']);
    expect(calls.find((c) => c.method === 'in')?.args).toEqual(['id', ['m1', 'm2', 'm3']]);
  });

  it('passes a failed read through', async () => {
    const { client } = makeClient({ data: null, error: { message: 'boom' } });
    const result = await rereadRemovedRows(client, {
      channelId: CHANNEL,
      messageIds: ['m1'],
      fromUserId: PEER,
    });
    expect(result.ok).toBe(false);
  });
});
