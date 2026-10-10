import { describe, expect, it, vi } from 'vitest';
import type { AgoraChat } from 'agora-chat';
import {
  appendMessage,
  breaksRun,
  isTimeGap,
  applyReactionOp,
  compareMessages,
  applyEdit,
  applyEditFromRow,
  DELETED_MESSAGE_LABEL,
  deleteEventExt,
  editEventExt,
  hydrateReplies,
  markMessagesDeleted,
  mapLiveTextMessage,
  markEventExt,
  missingReplyIds,
  markReadUpTo,
  markReadUpToMessage,
  mergeFetched,
  replyPreview,
  mergeReactions,
  oldestCursor,
  parseLiveEvent,
  parseLiveIds,
  pendingMessage,
  reactionEventExt,
  readEventExt,
  removeMessages,
  rowToThreadMessage,
  sendText,
  setMessageState,
  subscribeIncoming,
  targetFromSummary,
  THREAD_EVENT_HANDLER_ID,
  upsertMessage,
  withOutboxBubbles,
  setMessageAttachments,
  type ChannelTarget,
  type ChatMessageRow,
  type MessageReaction,
  type ThreadConnection,
  type ThreadMessage,
} from '@/lib/chat/thread';
import { toAgoraUsername } from '@/lib/chat/agora-identity';
import type { ChannelSummary } from '@/lib/chat-reads';

const ME = '11111111-1111-4111-8111-111111111111';
const PEER = '22222222-2222-4222-8222-222222222222';
const CHANNEL = 'group__ws__g1';
const GROUP_TARGET: ChannelTarget = { targetId: 'agora-group-1', chatType: 'groupChat' };

function txt(
  over: Omit<Partial<AgoraChat.TextMsgBody>, 'ext'> & { ext?: unknown | undefined },
): AgoraChat.TextMsgBody {
  return {
    id: 'agora-1',
    type: 'txt',
    chatType: 'groupChat',
    to: 'agora-group-1',
    from: toAgoraUsername(PEER),
    msg: 'hi',
    time: Date.parse('2026-09-22T10:00:05Z'),
    ext: { sorted_message_id: 'm-live', sorted_channel_id: CHANNEL },
    ...over,
  } as AgoraChat.TextMsgBody;
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

function row(over: Partial<ChatMessageRow>): ChatMessageRow {
  return {
    id: 'm1',
    channel_id: CHANNEL,
    workspace_id: 'ws',
    sender_user_id: PEER,
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
    created_at: '2026-09-22T10:00:00.123456+00:00',
    edited_at: null,
    deleted_at: null,
    ...over,
  };
}

function groupSummary(over: Partial<ChannelSummary> = {}): ChannelSummary {
  return {
    channelId: 'c-group',
    channelType: 'group',
    title: 'Team',
    avatarUrl: null,
    agoraGroupId: 'agora-group-1',
    groupId: 'g-1',
    peerUserId: null,
    createdAt: '2026-06-01T00:00:00Z',
    ...over,
  };
}

function dmSummary(over: Partial<ChannelSummary> = {}): ChannelSummary {
  return {
    channelId: 'c-dm',
    channelType: 'dm',
    title: 'Ada',
    avatarUrl: null,
    agoraGroupId: null,
    groupId: null,
    peerUserId: PEER,
    createdAt: '2026-06-01T00:00:00Z',
    ...over,
  };
}

function fakeConnection(over: Partial<ThreadConnection> = {}): ThreadConnection {
  return {
    send: vi.fn(),
    open: vi.fn(),
    close: vi.fn(),
    renewToken: vi.fn(),
    addEventHandler: vi.fn(),
    removeEventHandler: vi.fn(),
    ...over,
  } as unknown as ThreadConnection;
}

function mine(over: Partial<ThreadMessage>): ThreadMessage {
  return {
    id: 'x',
    senderUserId: ME,
    body: 'yo',
    createdAt: '2026-09-22T10:00:00+00:00',
    time: Date.parse('2026-09-22T10:00:00Z'),
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

describe('targetFromSummary', () => {
  it('maps a synced group to its Agora group id', () => {
    expect(targetFromSummary(groupSummary())).toEqual(GROUP_TARGET);
  });

  it('maps a DM to the peer Agora username', () => {
    expect(targetFromSummary(dmSummary())).toEqual({
      targetId: toAgoraUsername(PEER),
      chatType: 'singleChat',
    });
  });

  it('returns null when the channel has no live target yet', () => {
    expect(targetFromSummary(groupSummary({ agoraGroupId: null }))).toBeNull();
    expect(targetFromSummary(dmSummary({ peerUserId: null }))).toBeNull();
  });
});

describe('parseLiveIds / parseLiveEvent', () => {
  it('reads both Sorted ids and rejects a message missing either', () => {
    expect(parseLiveIds({ sorted_message_id: 'a', sorted_channel_id: 'c' })).toEqual({
      ok: true,
      ids: { sorted_message_id: 'a', sorted_channel_id: 'c' },
    });
    expect(parseLiveIds({ sorted_message_id: 'a' })).toEqual({ ok: false });
    expect(parseLiveIds({ sorted_channel_id: 'c' })).toEqual({ ok: false });
    expect(parseLiveIds(undefined)).toEqual({ ok: false });
  });

  it('parses reaction and read signals and rejects anything else', () => {
    expect(parseLiveEvent(reactionEventExt({ messageId: 'm', emoji: '👍', op: 'add' }))).toEqual({
      kind: 'reaction',
      messageId: 'm',
      emoji: '👍',
      op: 'add',
    });
    expect(parseLiveEvent(readEventExt({ channelId: 'c', messageId: 'm' }))).toEqual({
      kind: 'read',
      channelId: 'c',
      messageId: 'm',
    });
    expect(
      parseLiveEvent({ sorted_event: 'reaction', message_id: 'm', emoji: '👍', op: 'x' }),
    ).toEqual({ kind: 'unknown' });
    expect(parseLiveEvent(undefined)).toEqual({ kind: 'unknown' });
  });
});

describe('mapLiveTextMessage', () => {
  it('maps a stamped live message by its Sorted ids with the Agora server time', () => {
    const mapped = mapLiveTextMessage(txt({}), ME);
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.channelId).toBe(CHANNEL);
    expect(mapped.message).toMatchObject({
      id: 'm-live',
      senderUserId: PEER,
      body: 'hi',
      time: Date.parse('2026-09-22T10:00:05Z'),
      createdAt: '2026-09-22T10:00:05.000Z',
      provisionalTime: true,
      mine: false,
      state: 'sent',
    });
  });

  it('ignores a live message without the Sorted ids (pre-rewrite client)', () => {
    expect(mapLiveTextMessage(txt({ ext: undefined }), ME)).toEqual({
      ok: false,
      reason: 'missing_ids',
    });
    expect(mapLiveTextMessage(txt({ ext: { attachment_asset_ids: [] } }), ME).ok).toBe(false);
  });

  it('flags own messages and keeps a null sender for an unmappable username', () => {
    const own = mapLiveTextMessage(txt({ from: toAgoraUsername(ME) }), ME);
    expect(own.ok && own.message.mine).toBe(true);
    const odd = mapLiveTextMessage(txt({ from: 'not-agora' }), ME);
    expect(odd.ok && odd.message.senderUserId).toBeNull();
  });

  it('reads attachments, shared posts and the reply quote off the ext', () => {
    const mapped = mapLiveTextMessage(
      txt({
        ext: {
          sorted_message_id: 'm-live',
          sorted_channel_id: CHANNEL,
          attachment_asset_ids: ['a1'],
          attachment_meta: [{ assetId: 'a1', name: 'p.png', mime: 'image/png' }],
          shared_post_ids: ['p1'],
          reply_to: { id: 'm0', author_user_id: PEER, preview: 'earlier' },
        },
      }),
      ME,
    );
    expect(mapped.ok && mapped.message.attachments).toEqual([
      { assetId: 'a1', name: 'p.png', mime: 'image/png' },
    ]);
    expect(mapped.ok && mapped.message.sharedPostIds).toEqual(['p1']);
    expect(mapped.ok && mapped.message.reply).toEqual({
      id: 'm0',
      authorUserId: PEER,
      preview: 'earlier',
    });
  });
});

describe('rowToThreadMessage', () => {
  it('maps a record row with the verbatim server created_at', () => {
    const message = rowToThreadMessage(row({}), ME);
    expect(message).toMatchObject({
      id: 'm1',
      senderUserId: PEER,
      body: 'hello',
      createdAt: '2026-09-22T10:00:00.123456+00:00',
      provisionalTime: false,
      mine: false,
      state: 'sent',
      status: 'sent',
    });
    expect(message.time).toBe(Date.parse('2026-09-22T10:00:00.123Z'));
  });

  it('renders bare asset ids from the row and prefers the local rich content', () => {
    const bare = rowToThreadMessage(row({ body: null, attachment_asset_ids: ['a1'] }), ME);
    expect(bare.body).toBe('');
    expect(bare.attachments).toEqual([{ assetId: 'a1', name: '', mime: '' }]);

    const rich = rowToThreadMessage(row({ sender_user_id: ME, attachment_asset_ids: ['a1'] }), ME, {
      attachments: [{ assetId: 'a1', name: 'p.png', mime: 'image/png' }],
      sharedPostIds: ['p1'],
      reply: { id: 'm0', authorUserId: PEER, preview: 'earlier' },
    });
    expect(rich.mine).toBe(true);
    expect(rich.attachments[0]?.name).toBe('p.png');
    expect(rich.sharedPostIds).toEqual(['p1']);
    expect(rich.reply?.id).toBe('m0');
  });
});

describe('rowToThreadMessage from the persisted columns', () => {
  it('renders images, voice notes, shared posts and reply quotes from the row as they render live', () => {
    const quoted = rowToThreadMessage(
      row({ id: 'm0', body: 'the original', sender_user_id: ME }),
      ME,
    );
    const message = rowToThreadMessage(
      row({
        id: 'm2',
        body: null,
        attachment_asset_ids: ['img', 'voice', 'bare'],
        attachment_meta: {
          img: { mime: 'image/png', name: 'photo.png', size: 120 },
          voice: {
            mime: 'audio/webm',
            name: 'voice.webm',
            size: 900,
            duration_ms: 4000,
            transcript: 'hello there',
          },
        },
        shared_post_ids: ['post-1'],
        reply_to_message_id: 'm0',
      }),
      ME,
    );
    expect(message.attachments).toEqual([
      { assetId: 'img', name: 'photo.png', mime: 'image/png', size: 120 },
      {
        assetId: 'voice',
        name: 'voice.webm',
        mime: 'audio/webm',
        size: 900,
        durationMs: 4000,
        transcript: 'hello there',
      },
      { assetId: 'bare', name: '', mime: '' },
    ]);
    expect(message.sharedPostIds).toEqual(['post-1']);
    // The quote starts unresolved and fills from the loaded quoted message.
    expect(message.reply).toEqual({ id: 'm0', authorUserId: null, preview: '' });
    const [, hydrated] = hydrateReplies([quoted, message], []);
    expect(hydrated?.reply).toEqual({ id: 'm0', authorUserId: ME, preview: 'the original' });

    // Same content as the live Agora path produces for the same send.
    const live = mapLiveTextMessage(
      txt({
        msg: '',
        ext: {
          sorted_message_id: 'm2',
          sorted_channel_id: CHANNEL,
          attachment_asset_ids: ['img'],
          attachment_meta: [{ assetId: 'img', name: 'photo.png', mime: 'image/png', size: 120 }],
          shared_post_ids: ['post-1'],
        },
      }),
      ME,
    );
    expect(live.ok && live.message.attachments[0]).toEqual(message.attachments[0]);
    expect(live.ok && live.message.sharedPostIds).toEqual(message.sharedPostIds);
  });

  it('lists quoted ids that are not loaded and settles a missing one to a label', () => {
    const reply = rowToThreadMessage(row({ id: 'm2', reply_to_message_id: 'gone' }), ME);
    expect(missingReplyIds([reply])).toEqual(['gone']);
    expect(hydrateReplies([reply], [])[0]?.reply?.preview).toBe('');
    expect(hydrateReplies([reply], [], true)[0]?.reply?.preview).toBe('Message');
  });

  it('carries a quoted card message’s shared post ids as parentSharedPostIds', () => {
    const card = rowToThreadMessage(row({ id: 'card', body: null, shared_post_ids: ['p1'] }), ME);
    const reply = rowToThreadMessage(row({ id: 'm2', reply_to_message_id: 'card' }), ME);
    // From the IN read (the card is not loaded).
    const [fromRead] = hydrateReplies([reply], [card]);
    expect(fromRead?.parentSharedPostIds).toEqual(['p1']);
    expect(fromRead?.reply?.preview).toBe('Shared post');
    // From the loaded list.
    const [, fromLoaded] = hydrateReplies([card, reply], []);
    expect(fromLoaded?.parentSharedPostIds).toEqual(['p1']);
    // A plain parent carries none; a missing one settles with none.
    const plain = rowToThreadMessage(row({ id: 'card', body: 'hi' }), ME);
    expect(hydrateReplies([reply], [plain])[0]).not.toHaveProperty('parentSharedPostIds');
    expect(hydrateReplies([reply], [], true)[0]).not.toHaveProperty('parentSharedPostIds');
  });
});

describe('withOutboxBubbles', () => {
  const entry = (id: string, state: 'sending' | 'failed') => ({
    id,
    text: `draft ${id}`,
    local: { attachments: [], sharedPostIds: [], reply: null },
    state,
  });

  it('lays unrecorded sends after the newest loaded message in their outbox state', () => {
    const loaded = [mine({ id: 'm1', time: 1000 })];
    const list = withOutboxBubbles(loaded, [entry('f1', 'failed'), entry('s1', 'sending')], ME);
    expect(list.map((m) => [m.id, m.state])).toEqual([
      ['m1', 'sent'],
      ['f1', 'failed'],
      ['s1', 'sending'],
    ]);
    expect(list[1]?.time).toBeGreaterThan(1000);
  });

  it('renders an instant send at once from its local previews, one tile per file', () => {
    const file = new File(['abc'], 'a.png', { type: 'image/png' });
    const tile = (key: string) => ({
      assetId: '',
      name: `${key}.png`,
      mime: 'image/png',
      size: 3,
      local: { key, file, previewUrl: `blob:${key}`, progress: 0 },
    });
    const [bubble] = withOutboxBubbles(
      [],
      [
        {
          ...entry('p1', 'sending'),
          local: { ...entry('p1', 'sending').local, attachments: [tile('a'), tile('b')] },
        },
      ],
      ME,
    );
    expect(bubble?.state).toBe('sending');
    expect(bubble?.attachments.map((a) => a.local?.previewUrl)).toEqual(['blob:a', 'blob:b']);
    expect(bubble?.filesMissing).toBeUndefined();
    const moved = setMessageAttachments(bubble ? [bubble] : [], 'p1', [
      { ...tile('a'), local: { ...tile('a').local, progress: 0.5 } },
      tile('b'),
    ]);
    expect(moved[0]?.attachments.map((a) => a.local?.progress)).toEqual([0.5, 0]);
  });

  it('marks a restored send with lost files so the bubble offers Remove only', () => {
    const [bubble] = withOutboxBubbles(
      [],
      [{ ...entry('l1', 'failed'), filesMissing: true as const }],
      ME,
    );
    expect(bubble).toMatchObject({ id: 'l1', state: 'failed', filesMissing: true });
  });

  it('skips an entry whose row is already loaded, and re-lays a bubble after newer rows', () => {
    const recorded = mine({ id: 'f1', time: 1000 });
    expect(withOutboxBubbles([recorded], [entry('f1', 'failed')], ME)).toEqual([recorded]);
    const bubble = { ...mine({ id: 'f2', time: 5 }), state: 'failed' as const };
    const newer = mine({ id: 'm9', time: 2000 });
    const list = withOutboxBubbles([bubble, newer], [entry('f2', 'failed')], ME);
    expect(list.map((m) => m.id)).toEqual(['m9', 'f2']);
  });
});

describe('list transitions', () => {
  it('orders by server time then id, and appendMessage drops a duplicate id', () => {
    const a = mine({ id: 'a', time: 1 });
    const b = mine({ id: 'b', time: 1 });
    const c = mine({ id: 'c', time: 2 });
    expect([c, b, a].sort(compareMessages).map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(appendMessage([a], a)).toHaveLength(1);
    expect(appendMessage([c], a).map((m) => m.id)).toEqual(['a', 'c']);
  });

  it('mergeFetched replaces a provisional live message with its row, keeping live content', () => {
    const live = mine({
      id: 'm1',
      mine: false,
      provisionalTime: true,
      time: Date.parse('2026-09-22T10:00:05Z'),
      attachments: [{ assetId: 'a1', name: 'p.png', mime: 'image/png' }],
      reactions: [{ emoji: '👍', count: 1, mine: true }],
    });
    const fetched = rowToThreadMessage(row({ attachment_asset_ids: ['a1'] }), ME);
    const merged = mergeFetched([live], [fetched]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.createdAt).toBe('2026-09-22T10:00:00.123456+00:00');
    expect(merged[0]?.provisionalTime).toBe(false);
    expect(merged[0]?.attachments[0]?.name).toBe('p.png');
    expect(merged[0]?.reactions).toEqual([{ emoji: '👍', count: 1, mine: true }]);
  });

  it('mergeFetched tombstones a provisional live card whose delete event was missed', () => {
    const live = mine({
      id: 'm1',
      mine: false,
      provisionalTime: true,
      body: 'look',
      attachments: [{ assetId: 'a1', name: 'p.png', mime: 'image/png' }],
      sharedPostIds: ['p1'],
      sharedBriefIds: ['b1'],
      reply: { id: 'm0', authorUserId: ME, preview: 'hi' },
      reactions: [{ emoji: '👍', count: 1, mine: true }],
    });
    const fetched = rowToThreadMessage(
      row({ id: 'm1', body: null, deleted_at: '2026-09-22T10:02:00Z' }),
      ME,
    );
    const [merged] = mergeFetched([live], [fetched]);
    expect(merged).toMatchObject({
      id: 'm1',
      deleted: true,
      body: '',
      attachments: [],
      sharedPostIds: [],
      sharedBriefIds: [],
      reply: null,
      reactions: [],
      provisionalTime: false,
    });
  });

  it('mergeFetched leaves a recorded message alone and inserts new ids in order', () => {
    const recorded = mine({ id: 'm1', body: 'kept' });
    const older = rowToThreadMessage(
      row({ id: 'm0', created_at: '2026-09-22T09:00:00+00:00' }),
      ME,
    );
    const merged = mergeFetched([recorded], [older, rowToThreadMessage(row({ body: 'new' }), ME)]);
    expect(merged.map((m) => m.id)).toEqual(['m0', 'm1']);
    expect(merged[1]?.body).toBe('kept');
  });

  it('upsertMessage replaces by id and setMessageState flips one bubble', () => {
    const pending = mine({ id: 'p', state: 'sending', provisionalTime: true, createdAt: '' });
    const sent = mine({ id: 'p', state: 'sent' });
    expect(upsertMessage([pending], sent)[0]?.state).toBe('sent');
    expect(
      setMessageState([pending, mine({ id: 'q' })], 'p', 'failed').map((m) => m.state),
    ).toEqual(['failed', 'sent']);
  });

  it('pendingMessage is placed and labelled by the estimated server time of its tap', () => {
    const pending = pendingMessage({
      id: 'p',
      currentUserId: ME,
      text: 'draft',
      local: { attachments: [], sharedPostIds: [], reply: null },
      estimatedMs: 500,
    });
    expect(pending).toMatchObject({
      id: 'p',
      time: 500,
      estimatedMs: 500,
      createdAt: '',
      state: 'sending',
      provisionalTime: true,
    });
  });
});

describe('cursors', () => {
  it('read the oldest RECORDED (created_at, id) and skip provisional entries', () => {
    const list = [
      mine({ id: 'a', createdAt: '2026-09-22T09:00:00+00:00', time: 1 }),
      mine({ id: 'b', createdAt: '2026-09-22T10:00:00+00:00', time: 2 }),
      mine({ id: 'live', provisionalTime: true, time: 3 }),
      mine({ id: 'pending', state: 'sending', provisionalTime: true, createdAt: '', time: 4 }),
    ];
    expect(oldestCursor(list)).toEqual({ createdAt: '2026-09-22T09:00:00+00:00', id: 'a' });
    expect(oldestCursor([])).toBeUndefined();
  });
});

describe('reactions', () => {
  it('applyReactionOp adds, counts, removes and is idempotent for own toggles', () => {
    const base = [mine({ id: 'm' })];
    const added = applyReactionOp(base, { messageId: 'm', emoji: '👍', op: 'add', mine: true });
    expect(added[0]?.reactions).toEqual([{ emoji: '👍', count: 1, mine: true }]);
    const again = applyReactionOp(added, { messageId: 'm', emoji: '👍', op: 'add', mine: true });
    expect(again[0]?.reactions).toEqual([{ emoji: '👍', count: 1, mine: true }]);
    const peer = applyReactionOp(again, { messageId: 'm', emoji: '👍', op: 'add', mine: false });
    expect(peer[0]?.reactions).toEqual([{ emoji: '👍', count: 2, mine: true }]);
    const removed = applyReactionOp(peer, {
      messageId: 'm',
      emoji: '👍',
      op: 'remove',
      mine: true,
    });
    expect(removed[0]?.reactions).toEqual([{ emoji: '👍', count: 1, mine: false }]);
    const gone = applyReactionOp(removed, {
      messageId: 'm',
      emoji: '👍',
      op: 'remove',
      mine: false,
    });
    expect(gone[0]?.reactions).toEqual([]);
    expect(
      applyReactionOp(base, { messageId: 'other', emoji: '👍', op: 'add', mine: true }),
    ).toEqual(base);
  });

  it('mergeReactions sets reactions for mapped ids only', () => {
    const list = [mine({ id: 'a' }), mine({ id: 'b' })];
    const byId = new Map<string, MessageReaction[]>([
      ['a', [{ emoji: '❤️', count: 2, mine: false }]],
    ]);
    const merged = mergeReactions(list, byId);
    expect(merged[0]?.reactions).toEqual([{ emoji: '❤️', count: 2, mine: false }]);
    expect(merged[1]?.reactions).toEqual([]);
  });
});

describe('read ticks', () => {
  it('markReadUpTo advances own messages at or before the read time, monotonically', () => {
    const list = [
      mine({ id: 'a', time: 500 }),
      mine({ id: 'b', time: 1000 }),
      mine({ id: 'c', time: 2000 }),
      mine({ id: 'd', time: 500, mine: false }),
    ];
    expect(markReadUpTo(list, 1000).map((m) => m.status)).toEqual(['read', 'read', 'sent', 'sent']);
  });

  it('markReadUpToMessage resolves the id to its time and ignores an unknown id', () => {
    const list = [mine({ id: 'a', time: 500 }), mine({ id: 'b', time: 1000 })];
    expect(markReadUpToMessage(list, 'a').map((m) => m.status)).toEqual(['read', 'sent']);
    expect(markReadUpToMessage(list, 'zzz')).toEqual(list);
  });
});

describe('subscribeIncoming', () => {
  function subscribed(): {
    handler: AgoraChat.EventHandlerType | undefined;
    connection: ThreadConnection;
    onMessage: ReturnType<typeof vi.fn>;
    onIgnored: ReturnType<typeof vi.fn>;
    onReaction: ReturnType<typeof vi.fn>;
    onRead: ReturnType<typeof vi.fn>;
    teardown: () => void;
  } {
    const handlers: Record<string, AgoraChat.EventHandlerType> = {};
    const connection = fakeConnection({
      addEventHandler: vi.fn((id: string, handler: AgoraChat.EventHandlerType) => {
        handlers[id] = handler;
      }),
    });
    const onMessage = vi.fn();
    const onIgnored = vi.fn();
    const onReaction = vi.fn();
    const onRead = vi.fn();
    const teardown = subscribeIncoming({
      connection,
      channelId: CHANNEL,
      currentUserId: ME,
      onMessage,
      onIgnored,
      onReaction,
      onRead,
    });
    return {
      handler: handlers[THREAD_EVENT_HANDLER_ID],
      connection,
      onMessage,
      onIgnored,
      onReaction,
      onRead,
      teardown,
    };
  }

  it('delivers stamped messages for the open channel only and removes the handler on teardown', () => {
    const s = subscribed();
    expect(s.connection.addEventHandler).toHaveBeenCalledWith(
      THREAD_EVENT_HANDLER_ID,
      expect.any(Object),
    );
    s.handler?.onTextMessage?.(txt({}));
    s.handler?.onTextMessage?.(
      txt({ ext: { sorted_message_id: 'other', sorted_channel_id: 'group__ws__g2' } }),
    );
    expect(s.onMessage).toHaveBeenCalledTimes(1);
    expect(s.onMessage.mock.calls[0]?.[0]?.id).toBe('m-live');
    s.teardown();
    expect(s.connection.removeEventHandler).toHaveBeenCalledWith(THREAD_EVENT_HANDLER_ID);
  });

  it('reports and drops a message without the Sorted ids', () => {
    const s = subscribed();
    s.handler?.onTextMessage?.(txt({ id: 'legacy', ext: undefined }));
    expect(s.onMessage).not.toHaveBeenCalled();
    expect(s.onIgnored).toHaveBeenCalledWith('legacy');
  });

  it('routes reaction and read signals with the mapped sender, filtering read by channel', () => {
    const s = subscribed();
    s.handler?.onCmdMessage?.(
      cmd({ ext: reactionEventExt({ messageId: 'm', emoji: '👍', op: 'add' }) }),
    );
    expect(s.onReaction).toHaveBeenCalledWith({
      messageId: 'm',
      emoji: '👍',
      op: 'add',
      fromUserId: PEER,
    });
    s.handler?.onCmdMessage?.(cmd({ ext: readEventExt({ channelId: CHANNEL, messageId: 'm' }) }));
    s.handler?.onCmdMessage?.(
      cmd({ ext: readEventExt({ channelId: 'elsewhere', messageId: 'm' }) }),
    );
    expect(s.onRead).toHaveBeenCalledTimes(1);
    expect(s.onRead).toHaveBeenCalledWith({ messageId: 'm', fromUserId: PEER });
    // A typing command (no ext) and an unmappable sender are ignored.
    s.handler?.onCmdMessage?.(cmd({ action: 'typing' }));
    s.handler?.onCmdMessage?.(
      cmd({ from: 'nobody', ext: reactionEventExt({ messageId: 'm', emoji: '👍', op: 'add' }) }),
    );
    expect(s.onReaction).toHaveBeenCalledTimes(1);
  });
});

describe('sendText', () => {
  it('stamps the Sorted ids on ext alongside the content ext', async () => {
    const created = { id: 'created' } as unknown as AgoraChat.MessageBody;
    const createMessage = vi.fn().mockReturnValue(created);
    const send = vi.fn().mockResolvedValue({ serverMsgId: 's1', localMsgId: 'l1' });
    const connection = fakeConnection({ send });

    await sendText({
      connection,
      target: GROUP_TARGET,
      text: 'hello team',
      attachments: [{ assetId: 'a1', name: 'p.png', mime: 'image/png' }],
      sharedPostIds: ['p1'],
      reply: { id: 'm0', authorUserId: PEER, preview: 'earlier' },
      createMessage,
      liveIds: { sorted_message_id: 'm-new', sorted_channel_id: CHANNEL },
    });

    expect(createMessage).toHaveBeenCalledWith({
      chatType: 'groupChat',
      type: 'txt',
      to: 'agora-group-1',
      msg: 'hello team',
      ext: {
        attachment_asset_ids: ['a1'],
        attachment_meta: [{ assetId: 'a1', name: 'p.png', mime: 'image/png' }],
        shared_post_ids: ['p1'],
        reply_to: { id: 'm0', author_user_id: PEER, preview: 'earlier' },
        sorted_message_id: 'm-new',
        sorted_channel_id: CHANNEL,
      },
    });
    expect(send).toHaveBeenCalledWith(created);
  });

  it('keeps the bare text shape (no ext) for an unstamped plain send', async () => {
    const createMessage = vi.fn().mockReturnValue({} as AgoraChat.MessageBody);
    await sendText({
      connection: fakeConnection({ send: vi.fn().mockResolvedValue({}) }),
      target: GROUP_TARGET,
      text: 'plain',
      attachments: [],
      sharedPostIds: [],
      reply: null,
      createMessage,
    });
    expect(createMessage).toHaveBeenCalledWith({
      chatType: 'groupChat',
      type: 'txt',
      to: 'agora-group-1',
      msg: 'plain',
    });
  });
});

describe('delete and mark live events', () => {
  it('parses delete and mark signals, rejecting empty or malformed ids', () => {
    expect(parseLiveEvent(deleteEventExt({ messageIds: ['a', 'b'] }))).toEqual({
      kind: 'delete',
      messageIds: ['a', 'b'],
    });
    expect(parseLiveEvent({ sorted_event: 'delete', message_ids: [] })).toEqual({
      kind: 'unknown',
    });
    expect(parseLiveEvent({ sorted_event: 'delete', message_ids: 'a' })).toEqual({
      kind: 'unknown',
    });
    expect(parseLiveEvent(markEventExt({ messageId: 'm' }))).toEqual({
      kind: 'mark',
      messageId: 'm',
    });
    expect(parseLiveEvent({ sorted_event: 'mark' })).toEqual({ kind: 'unknown' });
  });

  it('onDelete fires with the ids; removeMessages drops ids (a Remove of a lost send)', () => {
    const handlers: Record<string, AgoraChat.EventHandlerType> = {};
    const connection = fakeConnection({
      addEventHandler: vi.fn((id: string, handler: AgoraChat.EventHandlerType) => {
        handlers[id] = handler;
      }),
    });
    const onDelete = vi.fn();
    const onRead = vi.fn();
    subscribeIncoming({
      connection,
      channelId: CHANNEL,
      currentUserId: ME,
      onMessage: vi.fn(),
      onIgnored: vi.fn(),
      onReaction: vi.fn(),
      onRead,
      onDelete,
    });
    const handler = handlers[THREAD_EVENT_HANDLER_ID];
    handler?.onCmdMessage?.(cmd({ ext: deleteEventExt({ messageIds: ['x', 'y'] }) }));
    // A mark signal is not a read signal and is left to the marks subscription.
    handler?.onCmdMessage?.(cmd({ ext: markEventExt({ messageId: 'x' }) }));
    expect(onDelete).toHaveBeenCalledWith({ messageIds: ['x', 'y'], fromUserId: PEER });
    expect(onRead).not.toHaveBeenCalled();

    const list = [mine({ id: 'x' }), mine({ id: 'k', time: 2 }), mine({ id: 'y', time: 3 })];
    expect(removeMessages(list, ['x', 'y']).map((m) => m.id)).toEqual(['k']);
    expect(removeMessages(list, ['nope'])).toBe(list);
  });
});

describe('shared briefs on a row', () => {
  it('reads shared_brief_ids off the row, and local briefs win on the own echo', () => {
    const fromRow = rowToThreadMessage(row({ body: null, shared_brief_ids: ['b1', 'b2'] }), ME);
    expect(fromRow.sharedBriefIds).toEqual(['b1', 'b2']);
    expect(fromRow.body).toBe('');
    expect(rowToThreadMessage(row({}), ME).sharedBriefIds).toEqual([]);
    const echo = rowToThreadMessage(row({ sender_user_id: ME }), ME, {
      attachments: [],
      sharedPostIds: [],
      sharedBriefIds: ['b9'],
      reply: null,
    });
    expect(echo.sharedBriefIds).toEqual(['b9']);
  });
});

describe('forwarded messages', () => {
  it('rowToThreadMessage maps forwarded_from_message_id to forwarded', () => {
    expect(rowToThreadMessage(row({ forwarded_from_message_id: 'src' }), ME).forwarded).toBe(true);
    expect(rowToThreadMessage(row({}), ME).forwarded).toBeUndefined();
  });

  it('the live path reads ext.forwarded_from', () => {
    const mapped = mapLiveTextMessage(
      txt({
        ext: { sorted_message_id: 'm-live', sorted_channel_id: CHANNEL, forwarded_from: 'src' },
      }),
      ME,
    );
    expect(mapped.ok && mapped.message.forwarded).toBe(true);
    const plain = mapLiveTextMessage(txt({}), ME);
    expect(plain.ok && plain.message.forwarded).toBeUndefined();
  });

  it('sendText stamps forwarded_from on the live ext', async () => {
    const createMessage = vi.fn().mockReturnValue({});
    await sendText({
      connection: { send: vi.fn().mockResolvedValue({}) } as unknown as ThreadConnection,
      target: GROUP_TARGET,
      text: 'fwd',
      attachments: [],
      sharedPostIds: [],
      reply: null,
      createMessage,
      liveIds: { sorted_message_id: 'm-new', sorted_channel_id: CHANNEL },
      forwardedFrom: 'src',
    });
    expect(createMessage).toHaveBeenCalledWith({
      chatType: 'groupChat',
      type: 'txt',
      to: 'agora-group-1',
      msg: 'fwd',
      ext: {
        attachment_asset_ids: [],
        attachment_meta: [],
        shared_post_ids: [],
        forwarded_from: 'src',
        sorted_message_id: 'm-new',
        sorted_channel_id: CHANNEL,
      },
    });
  });
});

describe('breaksRun / isTimeGap', () => {
  const at = (min: number) => Date.UTC(2026, 8, 22, 10, min);
  const own = (min: number) => ({ mine: true, senderUserId: 'me', time: at(min) });
  const peer = (min: number, id = 'p1') => ({ mine: false, senderUserId: id, time: at(min) });

  it('starts a run at the first message', () => {
    expect(breaksRun(undefined, own(0))).toBe(true);
  });

  it('keeps one sender under 10 minutes in one run', () => {
    expect(breaksRun(own(0), own(9))).toBe(false);
    expect(breaksRun(peer(0), peer(5))).toBe(false);
  });

  it('breaks on a sender switch or a different peer', () => {
    expect(breaksRun(own(0), peer(1))).toBe(true);
    expect(breaksRun(peer(0), own(1))).toBe(true);
    expect(breaksRun(peer(0, 'p1'), peer(1, 'p2'))).toBe(true);
  });

  it('breaks on a gap of exactly 10 minutes or more', () => {
    expect(isTimeGap(own(0), own(10))).toBe(true);
    expect(breaksRun(own(0), own(10))).toBe(true);
    expect(isTimeGap(own(0), own(9))).toBe(false);
  });

  it('never counts an unusable time as a gap', () => {
    expect(isTimeGap({ time: 0 }, own(30))).toBe(false);
    expect(isTimeGap(own(0), { time: 0 })).toBe(false);
  });
});

describe('edit and delete: mapping, merge and live events', () => {
  it('rowToThreadMessage maps edited_at, and a deleted row to a content-free tombstone', () => {
    const edited = rowToThreadMessage(row({ edited_at: '2026-09-22T10:05:00+00:00' }), ME);
    expect(edited.editedAt).toBe('2026-09-22T10:05:00+00:00');
    expect(edited.deleted).toBe(false);
    expect(rowToThreadMessage(row({}), ME).editedAt).toBeNull();

    // The DB nulls every content column on a deleted row; the mapping never renders content.
    const tomb = rowToThreadMessage(
      row({
        sender_user_id: ME,
        deleted_at: '2026-09-22T10:06:00+00:00',
        body: null,
        reply_to_message_id: 'm0',
        forwarded_from_message_id: 'src',
      }),
      ME,
      {
        attachments: [{ assetId: 'a', name: 'x', mime: 'image/png' }],
        sharedPostIds: ['p'],
        reply: null,
      },
    );
    expect(tomb).toMatchObject({
      id: 'm1',
      deleted: true,
      mine: true,
      body: '',
      attachments: [],
      sharedPostIds: [],
      sharedBriefIds: [],
      reply: null,
      reactions: [],
      createdAt: '2026-09-22T10:00:00.123456+00:00',
      state: 'sent',
    });
    expect(tomb.forwarded).toBeUndefined();
  });

  it('mergeFetched replaces a loaded message whose edited_at changed, keeping reactions and quote', () => {
    const loaded = mine({
      id: 'a',
      body: 'old',
      editedAt: null,
      reactions: [{ emoji: '👍', count: 1, mine: false }],
      reply: { id: 'q', authorUserId: PEER, preview: 'resolved' },
    });
    const fetched = { ...loaded, body: 'new', editedAt: '2026-09-22T10:01:00Z', reactions: [] };
    const [merged] = mergeFetched(
      [loaded],
      [{ ...fetched, reply: { id: 'q', authorUserId: null, preview: '' } }],
    );
    expect(merged?.body).toBe('new');
    expect(merged?.editedAt).toBe('2026-09-22T10:01:00Z');
    expect(merged?.reactions).toEqual(loaded.reactions);
    expect(merged?.reply?.preview).toBe('resolved');

    // Same edited_at: the loaded message is left alone.
    const same = [mine({ id: 'b', body: 'kept', editedAt: 'e1' })];
    expect(mergeFetched(same, [mine({ id: 'b', body: 'other', editedAt: 'e1' })])[0]?.body).toBe(
      'kept',
    );
  });

  it('mergeFetched turns a loaded message into a tombstone when the row comes back deleted', () => {
    const loaded = mine({
      id: 'a',
      body: 'hi',
      reactions: [{ emoji: '👍', count: 1, mine: true }],
    });
    const reply = mine({
      id: 'r',
      time: loaded.time + 1,
      reply: { id: 'a', authorUserId: ME, preview: 'hi' },
    });
    const tombRow = rowToThreadMessage(
      row({ id: 'a', sender_user_id: ME, body: null, deleted_at: '2026-09-22T10:02:00Z' }),
      ME,
    );
    const merged = mergeFetched([loaded, reply], [tombRow]);
    expect(merged[0]).toMatchObject({ id: 'a', deleted: true, body: '', reactions: [] });
    expect(merged[1]?.reply?.preview).toBe(DELETED_MESSAGE_LABEL);
    expect(merged[1]?.parentDeleted).toBe(true);
  });

  it('a deleted row survives a reload: history rows map to tombstones in place', () => {
    const rows = [
      row({ id: 'a', created_at: '2026-09-22T10:00:00Z' }),
      row({
        id: 'b',
        created_at: '2026-09-22T10:00:01Z',
        body: null,
        deleted_at: '2026-09-22T10:03:00Z',
      }),
      row({ id: 'c', created_at: '2026-09-22T10:00:02Z', reply_to_message_id: 'b' }),
    ];
    const fetched = rows.map((r) => rowToThreadMessage(r, ME));
    const list = hydrateReplies(mergeFetched([], fetched), [], true);
    expect(list.map((m) => [m.id, m.deleted])).toEqual([
      ['a', false],
      ['b', true],
      ['c', false],
    ]);
    expect(list[2]?.reply?.preview).toBe(DELETED_MESSAGE_LABEL);
    expect(list[2]?.parentDeleted).toBe(true);
  });

  it('hydrateReplies reads a quoted deleted row (by-ids read) as "Message deleted"', () => {
    const reply = mine({ id: 'r', reply: { id: 'gone', authorUserId: null, preview: '' } });
    const quoted = rowToThreadMessage(
      row({ id: 'gone', body: null, deleted_at: '2026-09-22T10:03:00Z' }),
      ME,
    );
    const [out] = hydrateReplies([reply], [quoted], true);
    expect(out?.reply).toEqual({ id: 'gone', authorUserId: PEER, preview: DELETED_MESSAGE_LABEL });
    expect(out?.parentDeleted).toBe(true);
  });

  it('markMessagesDeleted keeps the slot, clears content and reactions, and updates quotes', () => {
    const a = mine({
      id: 'a',
      body: 'x',
      reactions: [{ emoji: '👍', count: 1, mine: true }],
      forwarded: true,
    });
    const b = mine({
      id: 'b',
      time: a.time + 1,
      reply: { id: 'a', authorUserId: ME, preview: 'x' },
    });
    const list = markMessagesDeleted([a, b], ['a']);
    expect(list.map((m) => m.id)).toEqual(['a', 'b']);
    expect(list[0]).toMatchObject({ deleted: true, body: '', reactions: [], time: a.time });
    expect(list[0]?.forwarded).toBeUndefined();
    expect(list[1]?.reply?.preview).toBe(DELETED_MESSAGE_LABEL);
    expect(markMessagesDeleted(list, ['a'])).toBe(list);
    expect(markMessagesDeleted(list, ['nope'])).toBe(list);
  });

  it('parses the live edit event: one id, the body and edited_at', () => {
    const ext = editEventExt({ messageId: 'a', body: 'new', editedAt: '2026-09-22T10:01:00Z' });
    expect(ext).toEqual({
      sorted_event: 'edit',
      message_ids: ['a'],
      body: 'new',
      edited_at: '2026-09-22T10:01:00Z',
    });
    expect(parseLiveEvent(ext)).toEqual({
      kind: 'edit',
      messageId: 'a',
      body: 'new',
      editedAt: '2026-09-22T10:01:00Z',
    });
    for (const bad of [
      { sorted_event: 'edit', message_ids: [], body: 'x', edited_at: '2026-09-22T10:01:00Z' },
      {
        sorted_event: 'edit',
        message_ids: ['a', 'b'],
        body: 'x',
        edited_at: '2026-09-22T10:01:00Z',
      },
      { sorted_event: 'edit', message_ids: ['a'], edited_at: '2026-09-22T10:01:00Z' },
      { sorted_event: 'edit', message_ids: ['a'], body: 'x', edited_at: 'nope' },
    ]) {
      expect(parseLiveEvent(bad)).toEqual({ kind: 'unknown' });
    }
  });

  it('subscribeIncoming routes an edit to onEdit with the mapped sender', () => {
    const handlers: Record<string, AgoraChat.EventHandlerType> = {};
    const connection = fakeConnection({
      addEventHandler: vi.fn((id: string, handler: AgoraChat.EventHandlerType) => {
        handlers[id] = handler;
      }),
    });
    const onEdit = vi.fn();
    subscribeIncoming({
      connection,
      channelId: CHANNEL,
      currentUserId: ME,
      onMessage: vi.fn(),
      onIgnored: vi.fn(),
      onReaction: vi.fn(),
      onRead: vi.fn(),
      onEdit,
    });
    handlers[THREAD_EVENT_HANDLER_ID]?.onCmdMessage?.(
      cmd({ ext: editEventExt({ messageId: 'a', body: 'b', editedAt: '2026-09-22T10:01:00Z' }) }),
    );
    expect(onEdit).toHaveBeenCalledWith({
      messageId: 'a',
      body: 'b',
      editedAt: '2026-09-22T10:01:00Z',
      fromUserId: PEER,
    });
  });

  it('applyEditFromRow applies the stored body, not the live payload, and ignores unchanged rows', () => {
    const a = mine({ id: 'a', body: 'old' });
    const stored = row({ id: 'a', sender_user_id: ME, body: 'stored', edited_at: 'e1' });
    // The Agora payload claimed a different body; only the row counts.
    const out = applyEditFromRow([a], stored);
    expect(out[0]).toMatchObject({ body: 'stored', editedAt: 'e1' });
    expect(applyEditFromRow(out, stored)).toBe(out);
    const unedited = [a];
    expect(applyEditFromRow(unedited, row({ id: 'a', body: 'x', edited_at: null }))).toBe(unedited);
    expect(applyEditFromRow(unedited, row({ id: 'nope', edited_at: 'e1' }))).toBe(unedited);
  });

  it('applyEdit updates body and edited_at only, refreshes quotes, and skips tombstones', () => {
    const a = mine({
      id: 'a',
      body: 'old',
      attachments: [{ assetId: 'x', name: 'x.png', mime: 'image/png' }],
      sharedPostIds: ['p'],
    });
    const r = mine({
      id: 'r',
      time: a.time + 1,
      reply: { id: 'a', authorUserId: ME, preview: 'old' },
    });
    const out = applyEdit([a, r], { messageId: 'a', body: 'new', editedAt: 'e' });
    expect(out[0]).toMatchObject({
      body: 'new',
      editedAt: 'e',
      attachments: a.attachments,
      sharedPostIds: ['p'],
    });
    expect(out[1]?.reply?.preview).toBe('new');
    const tomb = markMessagesDeleted([a], ['a']);
    expect(applyEdit(tomb, { messageId: 'a', body: 'x', editedAt: 'e' })).toBe(tomb);
    expect(applyEdit([a], { messageId: 'nope', body: 'x', editedAt: 'e' })).toEqual([a]);
  });
});

describe('shared plans (shared_plan_ids)', () => {
  it('rowToThreadMessage keeps sharedPlanIds from the row', () => {
    const card = rowToThreadMessage(row({ id: 'p', body: null, shared_plan_ids: ['plan1'] }), ME);
    expect(card.sharedPlanIds).toEqual(['plan1']);
    const plain = rowToThreadMessage(row({ id: 'q' }), ME);
    expect(plain.sharedPlanIds ?? []).toEqual([]);
  });

  it('a tombstone row and a local delete both clear the plan ids', () => {
    const tomb = rowToThreadMessage(
      row({ id: 'p', body: null, shared_plan_ids: ['plan1'], deleted_at: '2026-09-22T10:05:00Z' }),
      ME,
    );
    expect(tomb.deleted).toBe(true);
    expect(tomb.sharedPlanIds ?? []).toEqual([]);
    const loaded = rowToThreadMessage(row({ id: 'p', body: null, shared_plan_ids: ['plan1'] }), ME);
    const [deleted] = markMessagesDeleted([loaded], ['p']);
    expect(deleted?.deleted).toBe(true);
    expect(deleted?.sharedPlanIds ?? []).toEqual([]);
  });

  it('replyPreview reads "Shared plan" for a bodyless plan card', () => {
    expect(
      replyPreview({ body: '', attachments: [], sharedPostIds: [], sharedPlanIds: ['plan1'] }),
    ).toBe('Shared plan');
    // Posts and briefs keep their own labels first.
    expect(
      replyPreview({
        body: '',
        attachments: [],
        sharedPostIds: ['p1'],
        sharedPlanIds: ['plan1'],
      }),
    ).toBe('Shared post');
  });

  it('mergeFetched keeps the non-empty plan ids (live provisional, then its row)', () => {
    const live = mine({ id: 'm1', mine: false, provisionalTime: true, body: '' });
    const fetched = rowToThreadMessage(row({ body: null, shared_plan_ids: ['plan1'] }), ME);
    const [merged] = mergeFetched([live], [fetched]);
    expect(merged?.sharedPlanIds).toEqual(['plan1']);
    const withIds = mine({ id: 'm1', provisionalTime: true, sharedPlanIds: ['plan1'] });
    const bare = rowToThreadMessage(row({ body: 'x' }), ME);
    const [kept] = mergeFetched([withIds], [bare]);
    expect(kept?.sharedPlanIds).toEqual(['plan1']);
  });
});
