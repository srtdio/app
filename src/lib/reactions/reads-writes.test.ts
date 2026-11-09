import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@srtdio/rpc';
import { readReactions, toReactionRows } from '@/lib/reactions/reads';
import { reactionProc, writeReaction } from '@/lib/reactions/writes';

/** A fake client that records every from/in/rpc call. */
function fakeClient(rows: unknown[] = []) {
  const calls = { from: [] as string[], in: [] as [string, string[]][], rpc: [] as unknown[][] };
  const client = {
    from(table: string) {
      calls.from.push(table);
      return {
        select() {
          return {
            in(key: string, ids: string[]) {
              calls.in.push([key, ids]);
              return Promise.resolve({ data: rows, error: null });
            },
          };
        },
      };
    },
    rpc: vi.fn((fn: string, args: unknown) => {
      calls.rpc.push([fn, args]);
      return Promise.resolve({ error: null });
    }),
  };
  return { client: client as unknown as Client, calls };
}

describe('reaction reads', () => {
  it('one batched IN query per page, never one per row (no N+1)', async () => {
    const { client, calls } = fakeClient([
      { comment_id: 'c1', user_id: 'u', emoji: '👍', created_at: 't' },
    ]);
    const result = await readReactions(client, 'comment', ['c1', 'c2', 'c3']);
    expect(calls.from).toEqual(['comment_reactions']);
    expect(calls.in).toEqual([['comment_id', ['c1', 'c2', 'c3']]]);
    expect(result.ok && result.data).toEqual([
      { targetId: 'c1', userId: 'u', emoji: '👍', createdAt: 't' },
    ]);
  });

  it('plan comments read their own table; chat reads chat_reactions by message_id', async () => {
    const plan = fakeClient();
    await readReactions(plan.client, 'plan-comment', ['p1']);
    expect(plan.calls.from).toEqual(['plan_item_comment_reactions']);
    const chat = fakeClient();
    await readReactions(chat.client, 'chat', ['m1']);
    expect(chat.calls.in).toEqual([['message_id', ['m1']]]);
  });

  it('no ids: no round trip', async () => {
    const { client, calls } = fakeClient();
    await readReactions(client, 'comment', []);
    expect(calls.from).toEqual([]);
  });

  it('maps raw rows by the kind key', () => {
    expect(
      toReactionRows('chat', [{ message_id: 'm', user_id: 'u', emoji: '✅', created_at: 't' }]),
    ).toEqual([{ targetId: 'm', userId: 'u', emoji: '✅', createdAt: 't' }]);
  });
});

describe('reaction writes', () => {
  it('names the proc per kind and op', () => {
    expect(reactionProc('comment', 'add')).toBe('comment_reaction_add');
    expect(reactionProc('comment', 'remove')).toBe('comment_reaction_remove');
    expect(reactionProc('plan-comment', 'add')).toBe('plan_item_comment_reaction_add');
    expect(reactionProc('plan-comment', 'remove')).toBe('plan_item_comment_reaction_remove');
  });

  it('sends the comment, the emoji and the trace id; never a user id', async () => {
    const { client, calls } = fakeClient();
    const result = await writeReaction(client, { kind: 'comment', id: 'c1' }, '👍', 'add', 'tr');
    expect(result.ok).toBe(true);
    expect(calls.rpc).toEqual([
      ['comment_reaction_add', { p_comment_id: 'c1', p_emoji: '👍', p_trace_id: 'tr' }],
    ]);
  });

  it('chat uses its record procs with the channel', async () => {
    const { client, calls } = fakeClient();
    await writeReaction(client, { kind: 'chat', id: 'm1', channelId: 'ch' }, '👍', 'remove', 'tr');
    expect(calls.rpc[0]?.[0]).toBe('chat_reaction_remove');
    expect(calls.rpc[0]?.[1]).toMatchObject({ p_channel_id: 'ch', p_message_id: 'm1' });
  });

  it('a refused write comes back not ok (the caller rolls back)', async () => {
    const { client } = fakeClient();
    (client.rpc as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      error: { message: 'comment deleted' },
    });
    const result = await writeReaction(client, { kind: 'plan-comment', id: 'p' }, '👍', 'add', 't');
    expect(result).toEqual({ ok: false, message: 'comment deleted' });
  });
});
