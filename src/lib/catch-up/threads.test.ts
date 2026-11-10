import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
}));
vi.mock('agora-chat', () => ({ default: {} }));
vi.mock('@/lib/env', () => ({ env: {} }));
vi.mock('@/lib/supabase', () => ({ supabase: { rpc: (...a: unknown[]) => h.rpc(...a) } }));

import { loadThreadsForMeAll, type ThreadForMeAll } from '@/lib/chat/thread-signals';
import { catchUpCardKind } from '@/lib/catch-up/copy';
import { unreadIdsOf } from '@/lib/catch-up/queue';
import { chatPointOf } from '@/lib/catch-up/writes';
import { decisionWrites } from '@/lib/catch-up/use-catch-up';
import {
  buildThreadsQueue,
  patchThreadUnread,
  peekThreads,
  peekThreadsQueue,
  resetThreadsStore,
  setThreads,
  unreadThreadCount,
} from '@/lib/catch-up/threads';

function thread(over: Partial<ThreadForMeAll> = {}): ThreadForMeAll {
  return {
    channelId: 'c1',
    rootId: 'r1',
    replyCount: 2,
    lastReplyAt: '2026-11-09T10:00:00.000Z',
    lastReplyId: 'm2',
    lastReplySender: 'u-other',
    lastReplyBody: 'hi',
    unread: true,
    ...over,
  };
}

beforeEach(() => {
  resetThreadsStore();
  h.rpc.mockReset();
});

describe('threads queue (the Threads button)', () => {
  it('only unread threads, newest reply first, one chat-thread card each', () => {
    const queue = buildThreadsQueue(
      [
        thread({ rootId: 'old', lastReplyAt: '2026-11-09T08:00:00.000Z' }),
        thread({ rootId: 'read', unread: false, lastReplyAt: '2026-11-09T12:00:00.000Z' }),
        thread({ rootId: 'new', channelId: 'c2', lastReplyAt: '2026-11-09T11:00:00.000Z' }),
      ],
      { workspaceId: 'w1', selfId: 'u-me' },
    );
    expect(queue.map((i) => i.key)).toEqual(['thread:c2:new', 'thread:c1:old']);
    for (const item of queue) {
      expect(item.kind).toBe('chat-thread');
      expect(item.source).toBe('threads');
      expect(catchUpCardKind(item.lead)).toBe('chat-thread');
    }
  });

  it('a card writes the thread read point only, never an inbox id', () => {
    const [item] = buildThreadsQueue([thread()], { workspaceId: 'w1', selfId: 'u-me' });
    if (item === undefined) throw new Error('no card');
    expect(unreadIdsOf(item)).toEqual([]);
    expect(decisionWrites(item)).toBe(true);
    expect(chatPointOf(item.lead)).toEqual({ channelId: 'c1', rootId: 'r1', messageId: 'm2' });
  });

  it('pre-launch threads are excluded (read by readBeforeLaunch in the loader)', async () => {
    h.rpc.mockResolvedValue({
      data: [
        {
          channel_id: 'c1',
          root_message_id: 'pre',
          reply_count: 3,
          last_reply_at: '2026-11-01T10:00:00.000Z',
          last_reply_id: 'm1',
          last_reply_sender: 'u-other',
          last_reply_body: 'old',
          unread: true,
        },
        {
          channel_id: 'c1',
          root_message_id: 'post',
          reply_count: 1,
          last_reply_at: '2026-11-09T10:00:00.000Z',
          last_reply_id: 'm9',
          last_reply_sender: 'u-other',
          last_reply_body: 'new',
          unread: true,
        },
      ],
      error: null,
    });
    const res = await loadThreadsForMeAll(
      { rpc: (...a: unknown[]) => h.rpc(...a) } as never,
      'w1',
      'trace-1',
    );
    if (!res.ok) throw new Error('read failed');
    expect(h.rpc).toHaveBeenCalledWith('chat_threads_for_me_all', {
      p_workspace_id: 'w1',
      p_trace_id: 'trace-1',
    });
    expect(unreadThreadCount(res.data)).toBe(1);
    expect(
      buildThreadsQueue(res.data, { workspaceId: 'w1', selfId: null }).map((i) => i.threadRootId),
    ).toEqual(['post']);
  });

  it('a decision patches the held list, so the count falls at once', () => {
    setThreads('w1', [thread(), thread({ rootId: 'r2' })]);
    expect(unreadThreadCount(peekThreads('w1'))).toBe(2);
    patchThreadUnread('w1', 'c1', 'r1', false);
    expect(unreadThreadCount(peekThreads('w1'))).toBe(1);
    expect(peekThreadsQueue('w1', 'u-me').map((i) => i.threadRootId)).toEqual(['r2']);
    patchThreadUnread('w1', 'c1', 'r1', true);
    expect(unreadThreadCount(peekThreads('w1'))).toBe(2);
  });

  it('nothing held: count 0, empty queue', () => {
    expect(unreadThreadCount(peekThreads('w1'))).toBe(0);
    expect(peekThreadsQueue('w1', null)).toEqual([]);
  });
});
