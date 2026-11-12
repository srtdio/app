// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelSummary } from '@/lib/chat-reads';
import type { ThreadMessage } from '@/lib/chat/thread';
import type { ThreadForMeAll } from '@/lib/chat/thread-signals';

const spies = vi.hoisted(() => ({
  markRead: vi.fn<(client: unknown, input: unknown) => Promise<{ ok: true }>>(async () => ({
    ok: true as const,
  })),
  writeReaction: vi.fn(async () => ({ ok: true as const })),
}));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/catch-up/writes', () => ({ markCatchUpRead: spies.markRead }));
vi.mock('@/lib/reactions/writes', () => ({ writeReaction: spies.writeReaction }));
vi.mock('@/lib/motion', async (orig) => ({
  ...(await orig<typeof import('@/lib/motion')>()),
  pushIn: () => ({ instant: true, done: Promise.resolve(), cancel: () => undefined }),
}));
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
vi.mock('@/components/chat/ChatStoreProvider', () => ({
  useChatStore: () => ({ roster: [group] }),
}));

import { ToastProvider, ToastViewport } from '@/components/ui/toast';
import { resetThreadsStore, setThreads } from '@/lib/catch-up/threads';
import {
  ThreadsListScreen,
  holdThreadBlock,
  resetThreadBlocks,
} from '@/components/pages/activity/ThreadsListScreen';

function msg(
  id: string,
  sender: string,
  at: string,
  over: Partial<ThreadMessage> = {},
): ThreadMessage {
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
    ...over,
  };
}

function thread(rootId: string, unread: boolean): ThreadForMeAll {
  return {
    rootId,
    channelId: 'c1',
    replyCount: 2,
    lastReplyAt: '2026-11-10T09:00:00Z',
    lastReplyId: `${rootId}-b`,
    lastReplySender: 'u2',
    lastReplyBody: 'ok',
    unread,
  };
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  resetThreadsStore();
  resetThreadBlocks();
  spies.markRead.mockClear();
  spies.writeReaction.mockClear();
  for (const id of ['r1', 'r2']) {
    holdThreadBlock(id, {
      root: msg(id, 'u1', '2026-11-09T06:00:00Z', {
        reactions: [{ emoji: '👍', count: 1, mine: false }],
      }),
      replies: [
        msg(`${id}-a`, 'u1', '2026-11-10T08:00:00Z'),
        msg(`${id}-b`, 'u2', '2026-11-10T09:00:00Z'),
      ],
      people: ['u1', 'u2'],
      lastReplyId: `${id}-b`,
    });
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

function mount(threads: ThreadForMeAll[]): void {
  setThreads('w1', threads);
  act(() =>
    root.render(
      <ToastProvider>
        <ThreadsListScreen
          workspaceId="w1"
          currentUserId="me"
          timeZone="UTC"
          onClose={() => undefined}
          onOpenThread={() => undefined}
        />
        <ToastViewport />
      </ToastProvider>,
    ),
  );
}

const q = (sel: string): Element | null => document.querySelector(sel);
const block = (id: string): Element | null => q(`[data-threads-block="${id}"]`);

describe('Threads list screen', () => {
  it('unread block: New line, Mark as read, Reply; a read thread never shows', () => {
    mount([thread('r1', true), thread('r2', false)]);
    expect(block('r1')?.querySelector('[data-new-line]')).not.toBeNull();
    expect(block('r1')?.querySelector('[data-threads-mark-read]')).not.toBeNull();
    expect(block('r1')?.querySelector('[data-threads-reply]')).not.toBeNull();
    expect(block('r2')).toBeNull();
    expect(q('[data-threads-unread]')?.textContent).toBe('1 unread');
  });

  it('replies draw no quote of the root (no "Member" box)', () => {
    // A reply quoting its root whose sender is not loaded: it read "Member".
    holdThreadBlock('r1', {
      root: msg('r1', 'u1', '2026-11-09T06:00:00Z'),
      replies: [
        msg('r1-b', 'u2', '2026-11-10T09:00:00Z', {
          reply: { id: 'r1', authorUserId: 'u-unknown', preview: 'root text' },
        }),
      ],
      people: ['u1', 'u2'],
      lastReplyId: 'r1-b',
    });
    mount([thread('r1', true)]);
    expect(block('r1')?.textContent).not.toContain('Member');
    expect(block('r1')?.textContent).not.toContain('root text');
  });

  it('"N unread" is hidden at 0', () => {
    mount([thread('r2', false)]);
    expect(q('[data-threads-unread]')).toBeNull();
  });

  it('Mark as read flips the block and the count at once; Undo restores; no write', () => {
    mount([thread('r1', true), thread('r2', true)]);
    expect(q('[data-threads-unread]')?.textContent).toBe('2 unread');
    act(() => (block('r1')?.querySelector('[data-threads-mark-read]') as HTMLElement).click());
    expect(block('r1')?.hasAttribute('data-unread')).toBe(false);
    expect(block('r1')?.querySelector('[data-threads-mark-read]')).toBeNull();
    expect(block('r1')?.querySelector('[data-new-line]')).toBeNull();
    expect(q('[data-threads-unread]')?.textContent).toBe('1 unread');
    const undo = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Undo',
    );
    expect(undo).toBeDefined();
    act(() => undo?.click());
    expect(block('r1')?.hasAttribute('data-unread')).toBe(true);
    expect(q('[data-threads-unread]')?.textContent).toBe('2 unread');
    expect(spies.markRead).not.toHaveBeenCalled();
  });

  it('Mark as read commits through the thread mark-read path when the strip ends', async () => {
    mount([thread('r1', true)]);
    act(() => (block('r1')?.querySelector('[data-threads-mark-read]') as HTMLElement).click());
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(spies.markRead).toHaveBeenCalledTimes(1);
    expect(spies.markRead.mock.calls[0]?.[1]).toMatchObject({ latestReplyId: 'r1-b' });
  });

  it('a reaction chip tap toggles through the chat reaction write, optimistically', () => {
    mount([thread('r2', true)]);
    const chip = block('r2')?.querySelector('[data-reaction-chip]') as HTMLElement | null;
    expect(chip).not.toBeNull();
    act(() => chip?.click());
    expect(spies.writeReaction).toHaveBeenCalledWith(
      {},
      { kind: 'chat', id: 'r2', channelId: 'c1' },
      '👍',
      'add',
      expect.any(String),
    );
    expect(block('r2')?.querySelector('[data-reaction-chip]')?.textContent).toContain('2');
  });
});
