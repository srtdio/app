// X4: the chat_task_create_many wrapper: one call with every task, the trace
// id explicit, ids back in order; a refusal is a failed result.
import { describe, expect, it } from 'vitest';
import type { Client } from '@srtdio/rpc';
import { createTasks, TASK_BATCH_MAX } from '@/lib/chat/tasks';

function client(answer: { data: unknown; error: { message: string } | null }) {
  const calls: [string, unknown][] = [];
  const c = {
    rpc: (fn: string, args: unknown) => {
      calls.push([fn, args]);
      return Promise.resolve(answer);
    },
  };
  return { client: c as unknown as Client, calls };
}

describe('X4 createTasks', () => {
  it('sends one chat_task_create_many with every task and the trace id', async () => {
    const { client: c, calls } = client({ data: ['a', 'b'], error: null });
    const res = await createTasks({
      client: c,
      channelId: 'c1',
      tasks: [
        { title: ' Hook ', side: 'agency' },
        { title: 'Caption', side: 'client', priority: 0, dueAt: '2026-10-20T15:30:00.000Z' },
      ],
      traceId: 'trace-1',
    });
    expect(res).toEqual({ ok: true, data: ['a', 'b'] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe('chat_task_create_many');
    expect(calls[0]?.[1]).toEqual({
      p_channel_id: 'c1',
      p_tasks: [
        { title: 'Hook', side: 'agency', priority: 2 },
        { title: 'Caption', side: 'client', priority: 0, due_at: '2026-10-20T15:30:00.000Z' },
      ],
      p_trace_id: 'trace-1',
    });
  });

  it('a refusal is a failed result; an empty or oversized batch never calls', async () => {
    const refused = client({ data: null, error: { message: 'not a member of this chat' } });
    const res = await createTasks({
      client: refused.client,
      channelId: 'c1',
      tasks: [{ title: 'Hook', side: 'agency' }],
      traceId: 't',
    });
    expect(res.ok).toBe(false);
    const none = client({ data: [], error: null });
    expect(
      (await createTasks({ client: none.client, channelId: 'c1', tasks: [], traceId: 't' })).ok,
    ).toBe(false);
    const big = Array.from({ length: TASK_BATCH_MAX + 1 }, () => ({
      title: 'x',
      side: 'agency' as const,
    }));
    expect(
      (await createTasks({ client: none.client, channelId: 'c1', tasks: big, traceId: 't' })).ok,
    ).toBe(false);
    expect(none.calls).toHaveLength(0);
  });
});
