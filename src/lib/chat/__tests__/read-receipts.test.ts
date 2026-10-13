import { describe, expect, it } from 'vitest';
import {
  covers,
  firstUnread,
  readByLabel,
  readByTarget,
  readersOf,
  resolvePositions,
  seenLineTarget,
  openCursorFrom,
  type ReadPosition,
} from '@/lib/chat/read-receipts';
import type { ThreadMessage } from '@/lib/chat/thread';

const ME = 'me';
const PEER = 'peer';

function msg(id: string, time: number, over: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id,
    senderUserId: over.mine === false ? PEER : ME,
    body: id,
    createdAt: new Date(time).toISOString(),
    time,
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

function pos(
  userId: string,
  id: string,
  time: number,
  lastReadAt = '2026-10-02T10:00:00Z',
  readAt: string | null = null,
): ReadPosition {
  return { userId, id, time, lastReadAt, readAt };
}

describe('T1 read-state helper', () => {
  it('a cursor on M or newer covers M; older does not', () => {
    expect(covers({ time: 10, id: 'b' }, { time: 10, id: 'b' })).toBe(true);
    expect(covers({ time: 20, id: 'a' }, { time: 10, id: 'z' })).toBe(true);
    expect(covers({ time: 5, id: 'z' }, { time: 10, id: 'a' })).toBe(false);
  });

  it('equal created_at ties on id', () => {
    expect(covers({ time: 10, id: 'c' }, { time: 10, id: 'b' })).toBe(true);
    expect(covers({ time: 10, id: 'a' }, { time: 10, id: 'b' })).toBe(false);
  });

  it('DM: the peer has read M when their cursor covers it', () => {
    const m = { time: 10, id: 'm', senderUserId: ME };
    const positions = new Map([[PEER, pos(PEER, 'n', 20)]]);
    expect(readersOf(m, positions, [PEER]).read.map((p) => p.userId)).toEqual([PEER]);
    const behind = new Map([[PEER, pos(PEER, 'k', 5)]]);
    expect(readersOf(m, behind, [PEER]).unread).toEqual([PEER]);
  });

  it('group: each member judged on their own cursor', () => {
    const m = { time: 10, id: 'm', senderUserId: ME };
    const positions = new Map([
      ['a', pos('a', 'm', 10)],
      ['b', pos('b', 'x', 9)],
    ]);
    const r = readersOf(m, positions, ['a', 'b', 'c']);
    expect(r.read.map((p) => p.userId)).toEqual(['a']);
    expect(r.unread).toEqual(['b', 'c']);
  });

  it('resolves cursor times from the lookup, else from last_read_at', () => {
    const rows = [
      { userId: 'a', lastReadMessageId: 'm1', lastReadAt: '2026-10-02T10:00:00Z', readAt: null },
      {
        userId: 'b',
        lastReadMessageId: 'gone',
        lastReadAt: '2026-10-02T11:00:00Z',
        readAt: '2026-10-02T12:00:00Z',
      },
    ];
    const out = resolvePositions(rows, (id) => (id === 'm1' ? 42 : undefined));
    expect(out.get('a')?.time).toBe(42);
    expect(out.get('b')?.time).toBe(Date.parse('2026-10-02T11:00:00Z'));
    expect(out.get('a')?.readAt).toBeNull();
    expect(out.get('b')?.readAt).toBe('2026-10-02T12:00:00Z');
  });
});

describe('T2 Seen line', () => {
  it('goes under the LAST own message the peer has read', () => {
    const list = [msg('a', 1), msg('b', 2), msg('p', 3, { mine: false }), msg('c', 4)];
    const peer = pos(PEER, 'b', 2, '2026-10-02T10:05:00Z', '2026-10-02T10:07:00Z');
    expect(seenLineTarget(list, peer)).toEqual({
      messageId: 'b',
      readAt: '2026-10-02T10:07:00Z',
    });
  });

  it('regression: the Seen time is read_at, never last_read_at (the message sent time)', () => {
    const sentMs = Date.parse('2026-10-02T09:01:00Z');
    const list = [msg('a', sentMs - 1000), msg('b', sentMs), msg('c', sentMs + 60_000)];
    const rows = [
      {
        userId: PEER,
        lastReadMessageId: 'b',
        lastReadAt: '2026-10-02T09:01:00Z',
        readAt: '2026-10-02T11:30:00Z',
      },
    ];
    const positions = resolvePositions(rows, (id) => list.find((m) => m.id === id)?.time);
    const peer = positions.get(PEER);
    // Ordering is unchanged: placed by the cursor message's created_at.
    expect(peer?.time).toBe(sentMs);
    expect(covers(peer!, list[1]!)).toBe(true);
    expect(covers(peer!, list[2]!)).toBe(false);
    expect(seenLineTarget(list, peer)).toEqual({ messageId: 'b', readAt: '2026-10-02T11:30:00Z' });
  });

  it('a cursor with no read_at gives a Seen slot with no time', () => {
    const list = [msg('a', 1), msg('b', 2)];
    expect(seenLineTarget(list, pos(PEER, 'b', 2))).toEqual({ messageId: 'b', readAt: null });
  });

  it('moves down as the peer reads further', () => {
    const list = [msg('a', 1), msg('b', 2), msg('c', 4)];
    expect(seenLineTarget(list, pos(PEER, 'c', 4))?.messageId).toBe('c');
  });

  it('never under a sending or failed bubble', () => {
    const list = [msg('a', 1), msg('s', 5, { state: 'sending' }), msg('f', 6, { state: 'failed' })];
    expect(seenLineTarget(list, pos(PEER, 'zz', 100))?.messageId).toBe('a');
  });

  it('nothing without a peer cursor or when none of mine is read', () => {
    expect(seenLineTarget([msg('a', 5)], undefined)).toBeNull();
    expect(seenLineTarget([msg('a', 5)], pos(PEER, 'x', 1))).toBeNull();
  });
});

describe('T3 Read by X of Y', () => {
  it('excludes the sender from Y', () => {
    const m = { time: 10, id: 'm', senderUserId: ME };
    const r = readersOf(m, new Map(), [ME, 'a', 'b']);
    expect(r.read.length + r.unread.length).toBe(2);
  });

  it('labels X of Y, and "Read by all" when equal', () => {
    expect(readByLabel(1, 3)).toBe('Read by 1 of 3');
    expect(readByLabel(3, 3)).toBe('Read by all');
    expect(readByLabel(0, 0)).toBeNull();
  });

  it('ex-members (not in the current member list) are not counted', () => {
    const m = { time: 10, id: 'm', senderUserId: ME };
    const positions = new Map([
      ['a', pos('a', 'm', 10)],
      ['left', pos('left', 'm', 10)],
    ]);
    const r = readersOf(m, positions, ['a', 'b']);
    expect(r.read.map((p) => p.userId)).toEqual(['a']);
    expect(r.unread).toEqual(['b']);
  });

  it('targets the last own message only when it is recorded', () => {
    expect(readByTarget([msg('a', 1), msg('b', 2)])?.id).toBe('b');
    expect(readByTarget([msg('a', 1), msg('b', 2, { state: 'sending' })])).toBeNull();
    expect(readByTarget([msg('a', 1), msg('d', 2, { deleted: true })])?.id).toBe('a');
  });
});

describe('T4 first unread from the cursor captured on open', () => {
  const list = [
    msg('a', 1, { mine: false }),
    msg('b', 2, { mine: false }),
    msg('mine', 3),
    msg('c', 4, { mine: false }),
  ];

  it('starts after the open cursor, counting others only', () => {
    const open = { kind: 'cursor' as const, position: { time: 1, id: 'a' } };
    expect(firstUnread({ messages: list, open, hasMore: false, unreadAtOpen: 0 })).toEqual({
      kind: 'loaded',
      firstId: 'b',
      count: 2,
    });
  });

  it('the open capture is unaffected by the cursor written after open', () => {
    const read = {
      rows: [
        { userId: ME, lastReadMessageId: 'a', lastReadAt: '2026-10-02T10:00:00Z', readAt: null },
      ],
      times: new Map([['a', 1]]),
    };
    const open = openCursorFrom(read, ME);
    // After open the thread writes its cursor to 'c'; the captured value stays.
    read.rows[0] = {
      userId: ME,
      lastReadMessageId: 'c',
      lastReadAt: '2026-10-02T10:01:00Z',
      readAt: null,
    };
    read.times.set('c', 4);
    expect(open).toEqual({ kind: 'cursor', position: { time: 1, id: 'a' } });
    expect(firstUnread({ messages: list, open, hasMore: false, unreadAtOpen: 0 })).toMatchObject({
      firstId: 'b',
    });
  });

  it('nothing unread when the cursor is at the newest', () => {
    const open = { kind: 'cursor' as const, position: { time: 4, id: 'c' } };
    expect(firstUnread({ messages: list, open, hasMore: false, unreadAtOpen: 0 })).toBeNull();
  });

  it('a cursor older than loaded history starts the run beyond it', () => {
    const open = { kind: 'cursor' as const, position: { time: 0, id: 'old' } };
    expect(firstUnread({ messages: list, open, hasMore: true, unreadAtOpen: 60 })).toEqual({
      kind: 'beyond',
      cursorId: 'old',
      count: 60,
    });
  });

  it('unknown cursor: nothing; no cursor row: all, only with full history', () => {
    expect(
      firstUnread({ messages: list, open: { kind: 'unknown' }, hasMore: false, unreadAtOpen: 0 }),
    ).toBeNull();
    expect(
      firstUnread({ messages: list, open: { kind: 'none' }, hasMore: false, unreadAtOpen: 0 }),
    ).toEqual({ kind: 'loaded', firstId: 'a', count: 3 });
    expect(
      firstUnread({ messages: list, open: { kind: 'none' }, hasMore: true, unreadAtOpen: 0 }),
    ).toBeNull();
  });
});
