import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@srtdio/rpc';
import type { ThreadMessage } from '@/lib/chat/thread';
import {
  chatOpenTarget,
  firstLineOf,
  firstUnreadReply,
  isThreadParticipant,
  isTopLevel,
  localThreadReadAt,
  mainChatMessages,
  markChatUnread,
  markThreadUnread,
  readBeforeLaunch,
  rememberThreadRead,
  repliesInfoByRoot,
  repliesLabel,
  setThreadRead,
  threadAlertText,
  threadPreviewLine,
  threadRootOf,
  threadsStripLabel,
  toThreadForMe,
  unreadTopLevelCount,
  withThreadRead,
  withThreadUnread,
  type ThreadForMe,
} from '@/lib/chat/thread-signals';

const NOW = Date.parse('2026-11-08T12:00:00Z');
const MIN = 60_000;

function msg(over: Partial<ThreadMessage> = {}): ThreadMessage {
  const createdAt = new Date(NOW - 5 * MIN).toISOString();
  return {
    id: 'm1',
    senderUserId: 'leo',
    body: 'hello',
    createdAt,
    time: Date.parse(createdAt),
    provisionalTime: false,
    mine: false,
    attachments: [],
    sharedPostIds: [],
    sharedBriefIds: [],
    reply: null,
    threadRootId: null,
    state: 'sent',
    status: 'sent',
    reactions: [],
    ...over,
  };
}

function at(minAgo: number): Pick<ThreadMessage, 'createdAt' | 'time'> {
  const createdAt = new Date(NOW - minAgo * MIN).toISOString();
  return { createdAt, time: Date.parse(createdAt) };
}

function thread(over: Partial<ThreadForMe> = {}): ThreadForMe {
  return {
    rootId: 'root',
    replyCount: 2,
    lastReplyAt: '2026-11-08T11:00:00Z',
    lastReplyId: 'r2',
    lastReplySender: 'leo',
    lastReplyBody: 'Done',
    unread: true,
    ...over,
  };
}

/** A small in-memory localStorage (the root suite runs in node). */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('L3: every reply is a thread; the main chat holds top-level messages only', () => {
  it('a recorded reply (thread root set) or a pending reply (a quote) is not top level', () => {
    expect(isTopLevel(msg())).toBe(true);
    expect(isTopLevel(msg({ threadRootId: 'root' }))).toBe(false);
    const pending = msg({ reply: { id: 'root', authorUserId: 'me', preview: 'x' } });
    delete pending.threadRootId;
    expect(isTopLevel(pending)).toBe(false);
  });

  it('existing quoted replies render as thread replies (they carry the root)', () => {
    const rows = [
      msg({ id: 'root' }),
      msg({
        id: 'q',
        threadRootId: 'root',
        reply: { id: 'root', authorUserId: 'leo', preview: 'hello' },
      }),
      msg({ id: 'next' }),
    ];
    expect(mainChatMessages(rows).map((m) => m.id)).toEqual(['root', 'next']);
  });

  it('a reply records with reply_to = the root: the root of a reply is its recorded root', () => {
    expect(threadRootOf(msg({ id: 'a' }))).toBe('a');
    expect(threadRootOf(msg({ id: 'b', threadRootId: 'root' }))).toBe('root');
    const pending = msg({
      id: 'c',
      reply: { id: 'p', authorUserId: null, preview: '', rootId: 'root' },
    });
    delete pending.threadRootId;
    expect(threadRootOf(pending)).toBe('root');
  });

  it('the replies row: count, up to 3 latest repliers newest first, the latest reply', () => {
    const rows = [
      msg({ id: 'root', senderUserId: 'me', mine: true }),
      msg({ id: 'r1', threadRootId: 'root', senderUserId: 'ana', ...at(40) }),
      msg({ id: 'r2', threadRootId: 'root', senderUserId: 'bo', ...at(30) }),
      msg({ id: 'r3', threadRootId: 'root', senderUserId: 'cy', ...at(20) }),
      msg({
        id: 'r4',
        threadRootId: 'root',
        senderUserId: 'leo',
        body: 'Done, it reads well now.',
        ...at(10),
      }),
      msg({ id: 'gone', threadRootId: 'root', senderUserId: 'ana', deleted: true, ...at(5) }),
      // A refused reply never counts.
      msg({ id: 'refused', threadRootId: 'root', senderUserId: 'me', state: 'failed', ...at(1) }),
    ];
    const info = repliesInfoByRoot(rows, (id) => id === 'root').get('root');
    expect(info?.count).toBe(4);
    expect(info?.repliers).toEqual(['leo', 'cy', 'bo']);
    expect(info?.last?.id).toBe('r4');
    expect(info?.unread).toBe(true);
    expect(repliesLabel(1)).toBe('1 reply');
    expect(repliesLabel(4)).toBe('4 replies');
  });

  it('the deleted root: its thread stays (replies still counted under the tombstone)', () => {
    const rows = [
      msg({ id: 'root', deleted: true, body: '' }),
      msg({ id: 'r1', threadRootId: 'root' }),
    ];
    expect(mainChatMessages(rows).map((m) => m.id)).toEqual(['root']);
    expect(repliesInfoByRoot(rows).get('root')?.count).toBe(1);
  });

  it('first lines strip format and skip blank lines', () => {
    expect(firstLineOf('\n*Bold* start\nsecond')).toBe('Bold start');
  });

  it('first lines read @Name for mentions, never a code; unknown reads @someone', () => {
    const ana = '11111111-1111-4111-8111-111111111111';
    const ghost = '22222222-2222-4222-8222-222222222222';
    const names = (id: string): string | undefined => (id === ana ? 'Ana' : undefined);
    expect(firstLineOf(`Ask @[${ana}] about it`, names)).toBe('Ask @Ana about it');
    expect(firstLineOf(`Ping @[${ghost}]`, names)).toBe('Ping @someone');
    expect(firstLineOf(`Ping @[${ghost}]`)).toBe('Ping @someone');
    expect(threadPreviewLine('Leo', `cc @[${ana}]`, names)).toBe('Leo in thread: cc @Ana');
    expect(threadPreviewLine('Leo', `cc @[${ana}]`, names)).not.toContain('@[');
  });
});

describe('L5 signals', () => {
  it('(1) alert text names the replier and the first line', () => {
    expect(threadAlertText('Leo', 'Done\nmore')).toBe('Leo replied in thread: Done');
  });

  it('(2) chat list preview for a thread reply', () => {
    expect(threadPreviewLine('Leo', 'Done, it reads well now.')).toBe(
      'Leo in thread: Done, it reads well now.',
    );
  });

  it('(4) the strip item counts unread threads only', () => {
    expect(threadsStripLabel([thread({ unread: false })])).toBeNull();
    expect(threadsStripLabel([thread()])).toBe('1 thread');
    expect(threadsStripLabel([thread(), thread({ rootId: 'b' })])).toBe('2 threads');
  });

  it('the participant rule: 6 or fewer members hear every thread', () => {
    const root = { senderUserId: 'ana', mentions: [] };
    expect(isThreadParticipant({ userId: 'me', memberCount: 6, root, replies: [] })).toBe(true);
    expect(isThreadParticipant({ userId: 'me', memberCount: 7, root, replies: [] })).toBe(false);
  });

  it('the participant rule over 6: root sender, replied, or mentioned', () => {
    const base = { userId: 'me', memberCount: 12 };
    expect(isThreadParticipant({ ...base, root: { senderUserId: 'me' }, replies: [] })).toBe(true);
    expect(
      isThreadParticipant({
        ...base,
        root: { senderUserId: 'ana' },
        replies: [{ senderUserId: 'me' }],
      }),
    ).toBe(true);
    expect(
      isThreadParticipant({
        ...base,
        root: { senderUserId: 'ana', mentions: ['me'] },
        replies: [],
      }),
    ).toBe(true);
    expect(
      isThreadParticipant({
        ...base,
        root: { senderUserId: 'ana' },
        replies: [{ senderUserId: 'bo', mentions: ['me'] }],
      }),
    ).toBe(true);
    expect(
      isThreadParticipant({
        ...base,
        root: { senderUserId: 'ana' },
        replies: [{ senderUserId: 'bo' }],
      }),
    ).toBe(false);
  });

  it('threads read before the launch start read; later ones keep their flag', () => {
    expect(readBeforeLaunch(thread({ lastReplyAt: '2026-11-01T00:00:00Z' })).unread).toBe(false);
    expect(readBeforeLaunch(thread({ lastReplyAt: '2026-11-08T11:00:00Z' })).unread).toBe(true);
  });

  it('local patches mark one thread read or unread', () => {
    const rows = [thread(), thread({ rootId: 'b', unread: false })];
    expect(withThreadRead(rows, 'root').map((t) => t.unread)).toEqual([false, false]);
    expect(withThreadUnread(rows, 'b').map((t) => t.unread)).toEqual([true, true]);
  });

  it('maps the proc row', () => {
    expect(
      toThreadForMe({
        root_message_id: 'root',
        reply_count: 3,
        last_reply_at: 'x',
        last_reply_id: 'r',
        last_reply_sender: 'leo',
        last_reply_body: 'b',
        unread: true,
      }),
    ).toEqual(thread({ replyCount: 3, lastReplyAt: 'x', lastReplyId: 'r', lastReplyBody: 'b' }));
  });
});

describe('L6b open rule (B)', () => {
  it('case 1: unread top-level messages open at the New line', () => {
    expect(chatOpenTarget({ unreadTopLevel: 2, threads: [thread()], painted: false })).toBe(
      'new-line',
    );
  });

  it('case 2: no unread top level, unread threads known before the paint: the Threads sheet', () => {
    expect(chatOpenTarget({ unreadTopLevel: 0, threads: [thread()], painted: false })).toBe(
      'threads',
    );
  });

  it('case 3: nothing unread opens as today; a late answer never pops the sheet', () => {
    expect(
      chatOpenTarget({ unreadTopLevel: 0, threads: [thread({ unread: false })], painted: false }),
    ).toBe('chat');
    expect(chatOpenTarget({ unreadTopLevel: 0, threads: null, painted: false })).toBe('chat');
    expect(chatOpenTarget({ unreadTopLevel: 0, threads: [thread()], painted: true })).toBe('chat');
  });

  it('unread top level counts only top-level messages from others after my cursor', () => {
    const rows = [
      msg({ id: 'a', ...at(30) }),
      msg({ id: 'b', ...at(10) }),
      msg({ id: 'c', ...at(9), mine: true }),
      msg({ id: 'd', ...at(8), threadRootId: 'a' }),
    ];
    expect(unreadTopLevelCount(rows, new Date(NOW - 20 * MIN).toISOString())).toBe(1);
    expect(unreadTopLevelCount(rows, null)).toBe(0);
  });
});

describe('L4/L7: the thread New line', () => {
  const replies = [
    { id: 'r1', mine: false, time: 1 },
    { id: 'r2', mine: true, time: 2 },
    { id: 'r3', mine: false, time: 3 },
    { id: 'r4', mine: false, time: 4 },
  ];

  it('sits above my first unread reply (this device read point)', () => {
    expect(firstUnreadReply(replies, { unread: true, readAt: 3 })).toBe('r4');
  });

  it('falls back to after my last own reply; none when read', () => {
    expect(firstUnreadReply(replies, { unread: true, readAt: null })).toBe('r3');
    expect(firstUnreadReply(replies, { unread: false, readAt: null })).toBeNull();
  });

  it('remembers the read point forward only, and back on Mark unread', () => {
    rememberThreadRead('root', 10);
    rememberThreadRead('root', 5);
    expect(localThreadReadAt('root')).toBe(10);
    rememberThreadRead('root', 5, true);
    expect(localThreadReadAt('root')).toBe(5);
  });
});

describe('L11 and the thread procs: one call each, trace id passed explicitly', () => {
  function fakeClient(): { client: Client; rpc: ReturnType<typeof vi.fn> } {
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    return { client: { rpc } as unknown as Client, rpc };
  }

  it('Mark unread on a main-chat message calls chat_mark_unread', async () => {
    const { client, rpc } = fakeClient();
    await expect(
      markChatUnread({ client, channelId: 'c', messageId: 'm', traceId: 't' }),
    ).resolves.toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledWith('chat_mark_unread', {
      p_channel_id: 'c',
      p_message_id: 'm',
      p_trace_id: 't',
    });
  });

  it('Mark unread on a thread reply calls chat_thread_mark_unread', async () => {
    const { client, rpc } = fakeClient();
    await markThreadUnread({ client, channelId: 'c', rootId: 'r', messageId: 'm', traceId: 't' });
    expect(rpc).toHaveBeenCalledWith('chat_thread_mark_unread', {
      p_channel_id: 'c',
      p_root_id: 'r',
      p_message_id: 'm',
      p_trace_id: 't',
    });
  });

  it('reading a thread calls chat_thread_read_set; a refusal comes back as not ok', async () => {
    const rpc = vi.fn(async () => ({
      data: null,
      error: { message: 'not a member of this chat' },
    }));
    const result = await setThreadRead({
      client: { rpc } as unknown as Client,
      channelId: 'c',
      rootId: 'r',
      messageId: 'm',
      traceId: 't',
    });
    expect(result).toEqual({ ok: false, message: 'not a member of this chat' });
  });
});
