import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@srtdio/rpc';
import {
  chatPointOf,
  markAllCatchUpRead,
  markCatchUpRead,
  undoCatchUpRead,
} from '@/lib/catch-up/writes';
import { cardOf, entry } from '@/lib/catch-up/test-fixtures';

function fakeClient(error: { message: string } | null = null) {
  const rpc = vi.fn((fn: string, args: Record<string, unknown>) => {
    void fn;
    void args;
    return Promise.resolve({ data: null, error, status: error ? 400 : 200 });
  });
  return { client: { rpc } as unknown as Client, rpc };
}

const thread = entry({
  id: 'e-thread',
  event_type: 'mention',
  entity_type: 'chat_channel',
  entity_id: 'c1',
  payload: { message_id: 'm2', thread_root_id: 'm1' },
});
const main = entry({
  id: 'e-main',
  event_type: 'mention',
  entity_type: 'chat_channel',
  entity_id: 'c1',
  payload: { message_id: 'm3' },
});
const comment = entry({ id: 'e-comment', event_type: 'comment', payload: { comment_id: 'k1' } });

describe('catch up writes', () => {
  it('chat points', () => {
    expect(chatPointOf(thread)).toEqual({ channelId: 'c1', rootId: 'm1', messageId: 'm2' });
    expect(chatPointOf(main)).toEqual({ channelId: 'c1', rootId: null, messageId: 'm3' });
    expect(chatPointOf(comment)).toBeNull();
  });

  it('Mark as read on a thread card: the entry, and the thread read to its newest reply', async () => {
    const { client, rpc } = fakeClient();
    const res = await markCatchUpRead(client, {
      workspaceId: 'w1',
      item: cardOf(thread),
      latestReplyId: 'm9',
      traceId: 't1',
    });
    expect(res.ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith('inbox_mark_read_ids', {
      p_workspace_id: 'w1',
      p_ids: ['e-thread'],
      p_trace_id: 't1',
    });
    expect(rpc).toHaveBeenCalledWith('chat_thread_read_set', {
      p_channel_id: 'c1',
      p_root_id: 'm1',
      p_message_id: 'm9',
      p_trace_id: 't1',
    });
  });

  it('Mark as read on a main-chat mention moves the read cursor to the message', async () => {
    const { client, rpc } = fakeClient();
    await markCatchUpRead(client, { workspaceId: 'w1', item: cardOf(main), traceId: 't2' });
    expect(rpc).toHaveBeenCalledWith('chat_read_cursor_set', {
      p_channel_id: 'c1',
      p_message_id: 'm3',
      p_trace_id: 't2',
    });
  });

  it('Mark as read on a comment card writes the entry only', async () => {
    const { client, rpc } = fakeClient();
    await markCatchUpRead(client, { workspaceId: 'w1', item: cardOf(comment), traceId: 't3' });
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(['inbox_mark_read_ids']);
  });

  it('Undo of a read: entry unread, and the same message unread in its chat', async () => {
    const t = fakeClient();
    await undoCatchUpRead(t.client, { workspaceId: 'w1', item: cardOf(thread), traceId: 't4' });
    expect(t.rpc.mock.calls.map((c) => c[0]).sort()).toEqual([
      'chat_thread_mark_unread',
      'inbox_mark_unread_ids',
    ]);
    const m = fakeClient();
    await undoCatchUpRead(m.client, { workspaceId: 'w1', item: cardOf(main), traceId: 't5' });
    expect(m.rpc.mock.calls.map((c) => c[0]).sort()).toEqual([
      'chat_mark_unread',
      'inbox_mark_unread_ids',
    ]);
    expect(m.rpc).toHaveBeenCalledWith('chat_mark_unread', {
      p_channel_id: 'c1',
      p_message_id: 'm3',
      p_trace_id: 't5',
    });
  });

  it('one card per item: Mark as read marks EVERY unread entry of the item in one call; Undo restores all', async () => {
    const c1 = entry({ id: 'k1', event_type: 'comment', payload: { comment_id: 'x1' } });
    const c2 = entry({
      id: 'k2',
      event_type: 'comment',
      created_at: '2026-11-08T11:00:00.000Z',
      payload: { comment_id: 'x2' },
    });
    const quiet = entry({ id: 'k3', event_type: 'post_deleted', created_at: '2026-11-08T09:00:00.000Z' });
    const read = entry({ id: 'k4', event_type: 'comment', read_at: '2026-11-08T12:00:00.000Z' });
    const card = cardOf(c2, c1, quiet, read);
    const m = fakeClient();
    await markCatchUpRead(m.client, { workspaceId: 'w1', item: card, traceId: 't8' });
    expect(m.rpc).toHaveBeenCalledTimes(1);
    expect(m.rpc).toHaveBeenCalledWith('inbox_mark_read_ids', {
      p_workspace_id: 'w1',
      p_ids: ['k2', 'k1', 'k3'],
      p_trace_id: 't8',
    });
    const u = fakeClient();
    await undoCatchUpRead(u.client, { workspaceId: 'w1', item: card, traceId: 't9' });
    expect(u.rpc).toHaveBeenCalledWith('inbox_mark_unread_ids', {
      p_workspace_id: 'w1',
      p_ids: ['k2', 'k1', 'k3'],
      p_trace_id: 't9',
    });
  });

  it('a failed write reports, never throws', async () => {
    const { client } = fakeClient({ message: 'nope' });
    const res = await markCatchUpRead(client, { workspaceId: 'w1', item: cardOf(comment), traceId: 't6' });
    expect(res).toEqual({ ok: false, message: 'nope' });
  });

  it('long-press marks every entry read through inbox_mark_all_read', async () => {
    const { client, rpc } = fakeClient();
    await markAllCatchUpRead(client, { workspaceId: 'w1', traceId: 't7' });
    expect(rpc.mock.calls[0]?.[0]).toBe('inbox_mark_all_read');
  });
});
