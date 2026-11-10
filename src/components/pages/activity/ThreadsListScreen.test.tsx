import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { PresignCache } from '@/lib/asset-presign';
import type { ChannelSummary } from '@/lib/chat-reads';
import type { ThreadMessage } from '@/lib/chat/thread';
import type { ThreadForMeAll } from '@/lib/chat/thread-signals';
import { rememberMentionNames } from '@/lib/chat/mentions';
import { MessageBubble } from '@/components/chat/MessageBubble';
import {
  DIRECT_MESSAGE_LINE,
  THREADS_LIST_EMPTY,
  ThreadsListBody,
  hiddenReplies,
  moreRepliesLabel,
  orderThreads,
  peopleLine,
  threadHeaderLines,
  type ThreadBlockData,
} from '@/components/pages/activity/ThreadsListScreen';

const cache = {} as unknown as PresignCache;
const WS = 'w1';
rememberMentionNames(WS, [
  { userId: 'me', displayName: 'Me Self' },
  { userId: 'u1', displayName: 'Chitra Raj' },
  { userId: 'u2', displayName: 'Manisha Thakur' },
]);

function thread(over: Partial<ThreadForMeAll> = {}): ThreadForMeAll {
  return {
    rootId: 'r1',
    channelId: 'c1',
    replyCount: 5,
    lastReplyAt: '2026-11-10T09:00:00Z',
    lastReplyId: 'x2',
    lastReplySender: 'u2',
    lastReplyBody: 'ok',
    unread: true,
    ...over,
  };
}

function msg(id: string, sender: string, at: string): ThreadMessage {
  return {
    id,
    senderUserId: sender,
    body: `body ${id}`,
    createdAt: at,
    time: Date.parse(at),
    provisionalTime: false,
    mine: sender === 'me',
    attachments: [],
    sharedPostIds: [],
    sharedBriefIds: [],
    reply: null,
    state: 'sent',
    status: 'sent',
    reactions: [],
  };
}

const group: ChannelSummary = {
  channelId: 'c1',
  channelType: 'group',
  title: 'Launch team',
  avatarUrl: null,
  agoraGroupId: null,
  groupId: 'g1',
  peerUserId: null,
  createdAt: '2026-11-01T00:00:00Z',
};
const dm: ChannelSummary = { ...group, channelId: 'c2', channelType: 'dm', title: 'Chitra Raj' };

function block(over: Partial<ThreadBlockData> = {}): ThreadBlockData {
  return {
    root: msg('r1', 'u1', '2026-11-09T06:47:00Z'),
    replies: [msg('x1', 'me', '2026-11-10T08:00:00Z'), msg('x2', 'u2', '2026-11-10T09:00:00Z')],
    people: ['u1', 'me', 'u2'],
    lastReplyId: 'x2',
    ...over,
  };
}

function render(
  threads: ThreadForMeAll[],
  blocks: Map<string, ThreadBlockData>,
  chats: ChannelSummary[] = [group, dm],
): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <ThreadsListBody
        threads={threads}
        chatOf={(id) => chats.find((c) => c.channelId === id)}
        blocks={blocks}
        failed={false}
        onRetry={() => undefined}
        onOpen={() => undefined}
        wiring={{
          workspaceId: WS,
          currentUserId: 'me',
          timeZone: 'UTC',
          layout: 'touch',
          cache,
          presignEnabled: false,
        }}
      />
    </MemoryRouter>,
  );
}

describe('Threads list rules', () => {
  it('people line', () => {
    expect(peopleLine([])).toBe('');
    expect(peopleLine(['A'])).toBe('A');
    expect(peopleLine(['A', 'B'])).toBe('A and B');
    expect(peopleLine(['A', 'B', 'C'])).toBe('A, B, and C');
    expect(peopleLine(['Chitra Raj', 'Manisha Thakur', 'C', 'D'])).toBe(
      'Chitra Raj, Manisha Thakur, and 2 others',
    );
  });

  it('header: the chat name and people; a DM reads the other person and "Direct message"', () => {
    expect(threadHeaderLines(group, ['A', 'B'])).toEqual({ name: 'Launch team', sub: 'A and B' });
    expect(threadHeaderLines(dm, ['A'])).toEqual({ name: 'Chitra Raj', sub: DIRECT_MESSAGE_LINE });
  });

  it('more replies label and count', () => {
    expect(moreRepliesLabel(1)).toBe('1 more reply');
    expect(moreRepliesLabel(3)).toBe('3 more replies');
    expect(hiddenReplies(5, 2)).toBe(3);
    expect(hiddenReplies(2, 2)).toBe(0);
    expect(hiddenReplies(1, 1)).toBe(0);
  });

  it('orders unread first, then newest reply first', () => {
    const a = thread({ rootId: 'a', unread: false, lastReplyAt: '2026-11-10T10:00:00Z' });
    const b = thread({ rootId: 'b', unread: true, lastReplyAt: '2026-11-09T10:00:00Z' });
    const c = thread({ rootId: 'c', unread: true, lastReplyAt: '2026-11-10T08:00:00Z' });
    expect(orderThreads([a, b, c]).map((t) => t.rootId)).toEqual(['c', 'b', 'a']);
  });
});

describe('Threads list body', () => {
  it('zero state', () => {
    expect(render([], new Map())).toContain(THREADS_LIST_EMPTY);
  });

  it('a group block: chat name, the people (not me), root, more replies, 2 replies, Reply', () => {
    const out = render([thread()], new Map([['r1', block()]]));
    expect(out).toContain('Launch team');
    expect(out).toContain('Chitra Raj and Manisha Thakur');
    expect(out).toContain('3 more replies');
    expect(out).toContain('data-threads-reply');
    for (const id of ['r1', 'x1', 'x2']) expect(out).toContain(`body ${id}`);
    expect(out).not.toContain('Workspace');
  });

  it('a DM block reads the other person and "Direct message"', () => {
    const out = render([thread({ channelId: 'c2' })], new Map([['r1', block()]]));
    expect(out).toContain('Chitra Raj');
    expect(out).toContain(DIRECT_MESSAGE_LINE);
  });

  it('no "more replies" when every reply shows', () => {
    const out = render([thread({ replyCount: 2 })], new Map([['r1', block()]]));
    expect(out).not.toContain('data-threads-more');
  });

  it('a band between blocks only, none after the last', () => {
    const t2 = thread({ rootId: 'r2', unread: false });
    const out = render(
      [thread(), t2],
      new Map([
        ['r1', block()],
        ['r2', block({ root: msg('r2', 'u1', '2026-11-08T06:00:00Z') })],
      ]),
    );
    expect(out.match(/data-threads-band/g)?.length).toBe(1);
    expect(out.match(/data-threads-block=/g)?.length).toBe(2);
    expect(out.lastIndexOf('data-threads-band')).toBeLessThan(
      out.lastIndexOf('data-threads-block='),
    );
  });

  it('a block not read yet keeps its frame (placeholder rows)', () => {
    const out = render([thread()], new Map());
    expect(out).toContain('data-thread-fill');
    expect(out).toContain('data-threads-reply');
  });

  it('times: the first message of each day carries its day, later ones the clock', () => {
    const out = render([thread()], new Map([['r1', block()]]));
    // Root 9 Nov, then 10 Nov 08:00 (day), 10 Nov 09:00 (clock only).
    expect(out).toMatch(/at 6:47 AM/);
    expect(out).toMatch(/at 8:00 AM/);
    expect(out).not.toMatch(/at 9:00 AM/);
    expect(out).toContain('9:00 AM');
  });
});

describe('MessageBubble timeLabel slot', () => {
  const base = {
    profiles: new Map(),
    cache,
    presignEnabled: false,
    showTicks: false,
    isGroup: true,
    head: true,
    tail: true,
    timeZone: 'UTC',
    layout: 'touch' as const,
  };
  it("default 'clock' keeps the clock time", () => {
    const m = msg('a', 'u1', '2026-11-01T14:54:00Z');
    const out = renderToStaticMarkup(<MessageBubble {...base} message={m} />);
    expect(out).toContain('2:54 PM');
    expect(out).not.toContain(' at 2:54 PM');
  });
  it("'day' shows the day and the clock", () => {
    const m = msg('a', 'u1', '2026-11-01T14:54:00Z');
    const out = renderToStaticMarkup(<MessageBubble {...base} message={m} timeLabel="day" />);
    expect(out).toContain(' at 2:54 PM');
  });
});
