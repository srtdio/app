import { describe, expect, it, vi } from 'vitest';
import type { AgoraChat } from 'agora-chat';
import {
  applyFilesRemoved,
  filesRemovedEventExt,
  parseLiveEvent,
  parseRemovedFiles,
  removedKindOf,
  rowToThreadMessage,
  subscribeIncoming,
  THREAD_EVENT_HANDLER_ID,
  type ChatMessageRow,
  type ThreadConnection,
  type ThreadMessage,
} from '@/lib/chat/thread';
import { toAgoraUsername } from '@/lib/chat/agora-identity';

const ME = '11111111-1111-4111-8111-111111111111';
const PEER = '22222222-2222-4222-8222-222222222222';
const CHANNEL = 'group__ws__g1';

function row(over: Partial<ChatMessageRow>): ChatMessageRow {
  return {
    id: 'm1',
    channel_id: CHANNEL,
    workspace_id: 'ws',
    sender_user_id: ME,
    body: 'hello',
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
    created_at: '2026-10-25T10:00:00.123456+00:00',
    edited_at: null,
    deleted_at: null,
    removed_files: {},
    ...over,
  };
}

function mine(over: Partial<ThreadMessage>): ThreadMessage {
  return {
    id: 'm1',
    senderUserId: ME,
    body: 'caption',
    createdAt: '2026-10-25T10:00:00+00:00',
    time: Date.parse('2026-10-25T10:00:00Z'),
    provisionalTime: false,
    mine: true,
    attachments: [],
    sharedPostIds: [],
    sharedBriefIds: [],
    reply: null,
    state: 'sent',
    status: 'sent',
    reactions: [],
    ...over,
  };
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

describe('parseRemovedFiles', () => {
  it('reads positive integer counts per kind', () => {
    expect(parseRemovedFiles({ photo: 2 })).toEqual({ photo: 2, video: 0, file: 0 });
    expect(parseRemovedFiles({ photo: 1, video: 3, file: 4 })).toEqual({
      photo: 1,
      video: 3,
      file: 4,
    });
  });

  it('is null for nothing removed or malformed values', () => {
    expect(parseRemovedFiles({})).toBeNull();
    expect(parseRemovedFiles(null)).toBeNull();
    expect(parseRemovedFiles(undefined)).toBeNull();
    expect(parseRemovedFiles([1, 2])).toBeNull();
    expect(parseRemovedFiles('photo')).toBeNull();
    expect(parseRemovedFiles({ photo: 0, video: -1, file: 1.5 })).toBeNull();
    expect(parseRemovedFiles({ photo: '2' })).toBeNull();
    // A bad key is dropped, a good one kept.
    expect(parseRemovedFiles({ photo: 'x', file: 1 })).toEqual({ photo: 0, video: 0, file: 1 });
  });

  it('removedKindOf counts images as photos, videos as videos, the rest as files', () => {
    expect(removedKindOf('image/png')).toBe('photo');
    expect(removedKindOf('video/quicktime')).toBe('video');
    expect(removedKindOf('application/pdf')).toBe('file');
    expect(removedKindOf('')).toBe('file');
  });
});

describe('rowToThreadMessage removed_files', () => {
  it('sets removedFiles only when a count is above zero', () => {
    expect(rowToThreadMessage(row({}), ME)).not.toHaveProperty('removedFiles');
    expect(rowToThreadMessage(row({ removed_files: { photo: 0 } }), ME)).not.toHaveProperty(
      'removedFiles',
    );
    const removed = rowToThreadMessage(
      row({
        removed_files: { photo: 2, file: 1 },
        attachment_asset_ids: ['a2'],
        attachment_meta: { a2: { name: 'two.jpg', mime: 'image/jpeg' } },
      }),
      ME,
    );
    expect(removed.removedFiles).toEqual({ photo: 2, video: 0, file: 1 });
    expect(removed.attachments.map((a) => a.assetId)).toEqual(['a2']);
    expect(removed.body).toBe('hello');
  });

  it('a tombstone row carries no removed counts', () => {
    const tomb = rowToThreadMessage(
      row({ deleted_at: '2026-10-25T10:01:00Z', removed_files: { photo: 1 } }),
      ME,
    );
    expect(tomb.deleted).toBe(true);
    expect(tomb.removedFiles).toBeUndefined();
  });
});

describe('the files_removed live event', () => {
  it('parses files_removed with its message ids and rejects empty or malformed ids', () => {
    expect(parseLiveEvent(filesRemovedEventExt({ messageIds: ['a', 'b'] }))).toEqual({
      kind: 'files_removed',
      messageIds: ['a', 'b'],
    });
    expect(filesRemovedEventExt({ messageIds: ['a'] })).toEqual({
      sorted_event: 'files_removed',
      message_ids: ['a'],
    });
    expect(parseLiveEvent({ sorted_event: 'files_removed', message_ids: [] })).toEqual({
      kind: 'unknown',
    });
    expect(parseLiveEvent({ sorted_event: 'files_removed', message_ids: 'a' })).toEqual({
      kind: 'unknown',
    });
    expect(parseLiveEvent({ sorted_event: 'files_removed', message_ids: ['', 3, 'x'] })).toEqual({
      kind: 'files_removed',
      messageIds: ['x'],
    });
  });

  it('subscribeIncoming ignores files_removed (no read, delete or reaction)', () => {
    const handlers: Record<string, AgoraChat.EventHandlerType> = {};
    const connection = {
      send: vi.fn(),
      open: vi.fn(),
      close: vi.fn(),
      renewToken: vi.fn(),
      addEventHandler: vi.fn((id: string, handler: AgoraChat.EventHandlerType) => {
        handlers[id] = handler;
      }),
      removeEventHandler: vi.fn(),
    } as unknown as ThreadConnection;
    const onRead = vi.fn();
    const onDelete = vi.fn();
    const onReaction = vi.fn();
    const onEdit = vi.fn();
    subscribeIncoming({
      connection,
      channelId: CHANNEL,
      currentUserId: ME,
      onMessage: vi.fn(),
      onIgnored: vi.fn(),
      onReaction,
      onRead,
      onDelete,
      onEdit,
    });
    handlers[THREAD_EVENT_HANDLER_ID]?.onCmdMessage?.(
      cmd({ ext: filesRemovedEventExt({ messageIds: ['m1'] }) }),
    );
    expect(onRead).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
    expect(onReaction).not.toHaveBeenCalled();
    expect(onEdit).not.toHaveBeenCalled();
  });
});

describe('applyFilesRemoved', () => {
  const photo = { assetId: 'a1', name: 'one.jpg', mime: 'image/jpeg' };
  const photo2 = { assetId: 'a2', name: 'two.jpg', mime: 'image/jpeg' };
  const pdf = { assetId: 'f1', name: 'brief.pdf', mime: 'application/pdf' };

  it('drops the listed files and adds their kinds to the counts', () => {
    const list = [mine({ attachments: [photo, photo2, pdf], removedFiles: { photo: 1, video: 0, file: 0 } })];
    const [out] = applyFilesRemoved(list, new Map([['m1', new Set(['a1', 'f1'])]]));
    expect(out?.attachments).toEqual([photo2]);
    expect(out?.removedFiles).toEqual({ photo: 2, video: 0, file: 1 });
  });

  it('the last file with text keeps the text and the counts', () => {
    const [out] = applyFilesRemoved(
      [mine({ body: 'see attached', attachments: [pdf] })],
      new Map([['m1', new Set(['f1'])]]),
    );
    expect(out?.deleted).toBeUndefined();
    expect(out?.body).toBe('see attached');
    expect(out?.attachments).toEqual([]);
    expect(out?.removedFiles).toEqual({ photo: 0, video: 0, file: 1 });
  });

  it('the last file with no text becomes a tombstone without removedFiles', () => {
    const [out] = applyFilesRemoved(
      [mine({ body: '  ', attachments: [photo] })],
      new Map([['m1', new Set(['a1'])]]),
    );
    expect(out?.deleted).toBe(true);
    expect(out?.removedFiles).toBeUndefined();
    expect(out?.attachments).toEqual([]);
  });

  it('a message that still shares a post is kept', () => {
    const [out] = applyFilesRemoved(
      [mine({ body: '', attachments: [photo], sharedPostIds: ['p1'] })],
      new Map([['m1', new Set(['a1'])]]),
    );
    expect(out?.deleted).toBeUndefined();
    expect(out?.removedFiles).toEqual({ photo: 1, video: 0, file: 0 });
  });

  it('is idempotent and returns the same list when nothing changes', () => {
    const list = [mine({ attachments: [photo2] }), mine({ id: 'gone', deleted: true })];
    expect(applyFilesRemoved(list, new Map([['m1', new Set(['a1'])]]))).toBe(list);
    expect(applyFilesRemoved(list, new Map([['gone', new Set(['a1'])]]))).toBe(list);
    expect(applyFilesRemoved(list, new Map())).toBe(list);
  });
});
