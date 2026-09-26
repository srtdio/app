import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@srtdio/rpc';
import {
  addReactionRecord,
  removeReactionRecord,
  sendMessageRecord,
  setReadCursorRecord,
} from '@/lib/chat/record';

const ID = '019935a0-0000-7000-8000-000000000001';
const CHANNEL = 'group__ws__g1';

/** A recording rpc builder with abortSignal; awaiting yields the configured result. */
function makeClient(result: { data: unknown; error: { message: string } | null } | 'hang') {
  const rpc = vi.fn();
  const abortSignal = vi.fn();
  rpc.mockImplementation(() => {
    const builder = {
      abortSignal: (signal: AbortSignal) => {
        abortSignal(signal);
        if (result === 'hang') {
          return new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(new Error('AbortError')));
          });
        }
        return Promise.resolve(result);
      },
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve(result === 'hang' ? { data: null, error: null } : result).then(resolve),
    };
    return builder;
  });
  return { client: { rpc } as unknown as Client, rpc, abortSignal };
}

const row = { id: ID, channel_id: CHANNEL, created_at: '2026-09-22T10:00:00+00:00' };

describe('sendMessageRecord', () => {
  it('calls chat_message_send with the explicit trace id and omits an empty body', async () => {
    const { client, rpc, abortSignal } = makeClient({ data: row, error: null });
    const result = await sendMessageRecord({
      client,
      id: ID,
      channelId: CHANNEL,
      traceId: 'trace-1',
      body: '  ',
      attachmentAssetIds: ['v1'],
    });
    expect(rpc).toHaveBeenCalledWith('chat_message_send', {
      p_id: ID,
      p_channel_id: CHANNEL,
      p_trace_id: 'trace-1',
      p_attachment_asset_ids: ['v1'],
    });
    expect(abortSignal).toHaveBeenCalledOnce();
    expect(result.ok && result.row.id).toBe(ID);
  });

  it('passes shared posts, the reply target and attachment meta; a shared-posts-only send has no body', async () => {
    const { client, rpc } = makeClient({ data: row, error: null });
    const result = await sendMessageRecord({
      client,
      id: ID,
      channelId: CHANNEL,
      traceId: 'trace-1',
      body: '',
      attachmentAssetIds: ['v1'],
      sharedPostIds: ['post-1', 'post-2'],
      replyToMessageId: 'quoted-1',
      attachmentMeta: { v1: { mime: 'audio/webm', name: 'v.webm', size: 10, duration_ms: 3000 } },
    });
    expect(rpc).toHaveBeenCalledWith('chat_message_send', {
      p_id: ID,
      p_channel_id: CHANNEL,
      p_trace_id: 'trace-1',
      p_attachment_asset_ids: ['v1'],
      p_shared_post_ids: ['post-1', 'post-2'],
      p_reply_to_message_id: 'quoted-1',
      p_attachment_meta: {
        v1: { mime: 'audio/webm', name: 'v.webm', size: 10, duration_ms: 3000 },
      },
    });
    expect(result.ok).toBe(true);
  });

  it('omits empty shared posts, a null reply and empty meta', async () => {
    const { client, rpc } = makeClient({ data: row, error: null });
    await sendMessageRecord({
      client,
      id: ID,
      channelId: CHANNEL,
      traceId: 'trace-1',
      body: 'hi',
      attachmentAssetIds: [],
      sharedPostIds: [],
      replyToMessageId: null,
      attachmentMeta: {},
    });
    expect(rpc).toHaveBeenCalledWith('chat_message_send', {
      p_id: ID,
      p_channel_id: CHANNEL,
      p_trace_id: 'trace-1',
      p_body: 'hi',
    });
  });

  it('passes the trimmed body and no attachments for a text send', async () => {
    const { client, rpc } = makeClient({ data: row, error: null });
    await sendMessageRecord({
      client,
      id: ID,
      channelId: CHANNEL,
      traceId: 'trace-1',
      body: ' hello ',
      attachmentAssetIds: [],
    });
    expect(rpc).toHaveBeenCalledWith('chat_message_send', {
      p_id: ID,
      p_channel_id: CHANNEL,
      p_trace_id: 'trace-1',
      p_body: 'hello',
    });
  });

  it('reports a proc error without throwing', async () => {
    const { client } = makeClient({ data: null, error: { message: 'not a member of this chat' } });
    const result = await sendMessageRecord({
      client,
      id: ID,
      channelId: CHANNEL,
      traceId: 't',
      body: 'x',
      attachmentAssetIds: [],
    });
    expect(result).toEqual({ ok: false, reason: 'error', message: 'not a member of this chat' });
  });

  it('aborts after the timeout and reports it as a timeout', async () => {
    vi.useFakeTimers();
    try {
      const { client } = makeClient('hang');
      const pending = sendMessageRecord({
        client,
        id: ID,
        channelId: CHANNEL,
        traceId: 't',
        body: 'x',
        attachmentAssetIds: [],
        timeoutMs: 50,
      });
      await vi.advanceTimersByTimeAsync(60);
      const result = await pending;
      expect(result.ok).toBe(false);
      expect(!result.ok && result.reason).toBe('timeout');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('reaction and read-cursor records', () => {
  it('call their procs with channel, message, emoji and the explicit trace id', async () => {
    const { client, rpc } = makeClient({ data: null, error: null });
    const base = { client, channelId: CHANNEL, messageId: 'm1', traceId: 'trace-2' };
    expect(await addReactionRecord({ ...base, emoji: '👍' })).toEqual({ ok: true });
    expect(await removeReactionRecord({ ...base, emoji: '👍' })).toEqual({ ok: true });
    expect(await setReadCursorRecord(base)).toEqual({ ok: true });
    expect(rpc.mock.calls).toEqual([
      [
        'chat_reaction_add',
        { p_channel_id: CHANNEL, p_message_id: 'm1', p_emoji: '👍', p_trace_id: 'trace-2' },
      ],
      [
        'chat_reaction_remove',
        { p_channel_id: CHANNEL, p_message_id: 'm1', p_emoji: '👍', p_trace_id: 'trace-2' },
      ],
      [
        'chat_read_cursor_set',
        { p_channel_id: CHANNEL, p_message_id: 'm1', p_trace_id: 'trace-2' },
      ],
    ]);
  });

  it('surfaces a proc error as a Result', async () => {
    const { client } = makeClient({ data: null, error: { message: 'message not found' } });
    expect(
      await setReadCursorRecord({ client, channelId: CHANNEL, messageId: 'x', traceId: 't' }),
    ).toEqual({ ok: false, message: 'message not found' });
  });
});
