import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@srtdio/rpc';
import {
  addReactionRecord,
  chunkIds,
  clearChannelRecord,
  deleteMessagesRecord,
  deleteFailureCopy,
  editFailureCopy,
  editMessageRecord,
  removeReactionRecord,
  reopenMarkRecord,
  resolveMarkRecord,
  setMarkRecord,
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

/** A recording rpc whose nth call can fail. */
function voidClient(failOnCall?: number) {
  let n = 0;
  const rpc = vi.fn(() => {
    n += 1;
    return Promise.resolve(
      n === failOnCall
        ? { data: null, error: { message: 'marked messages cannot be deleted' } }
        : { data: null, error: null },
    );
  });
  return { client: { rpc } as unknown as Client, rpc };
}

describe('sendMessageRecord with shared briefs', () => {
  it('sends p_shared_brief_ids; a briefs-only send carries no body', async () => {
    const { client, rpc } = makeClient({ data: row, error: null });
    await sendMessageRecord({
      client,
      id: ID,
      channelId: CHANNEL,
      traceId: 'trace-1',
      body: '',
      attachmentAssetIds: [],
      sharedBriefIds: ['brief-1'],
    });
    expect(rpc).toHaveBeenCalledWith('chat_message_send', {
      p_id: ID,
      p_channel_id: CHANNEL,
      p_trace_id: 'trace-1',
      p_shared_brief_ids: ['brief-1'],
    });
  });
});

describe('mark records', () => {
  it('a pending priority change calls chat_mark_set with the same type and the new priority', async () => {
    const { client, rpc } = voidClient();
    const result = await setMarkRecord({
      client,
      channelId: CHANNEL,
      messageId: 'm1',
      type: 'pending',
      priority: 2,
      traceId: 't1',
    });
    expect(result.ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith('chat_mark_set', {
      p_message_id: 'm1',
      p_channel_id: CHANNEL,
      p_mark_type: 'pending',
      p_priority: 2,
      p_trace_id: 't1',
    });
  });

  it('commitment and decision always send a null priority; unranked pending sends null', async () => {
    const { client, rpc } = voidClient();
    await setMarkRecord({
      client,
      channelId: CHANNEL,
      messageId: 'm1',
      type: 'commitment',
      priority: 1,
      traceId: 't1',
    });
    await setMarkRecord({
      client,
      channelId: CHANNEL,
      messageId: 'm2',
      type: 'pending',
      priority: null,
      traceId: 't2',
    });
    expect(rpc.mock.calls.map((c) => (c as unknown[])[1])).toEqual([
      expect.objectContaining({ p_mark_type: 'commitment', p_priority: null }),
      expect.objectContaining({ p_mark_type: 'pending', p_priority: null }),
    ]);
  });

  it('resolve calls chat_mark_resolve with the explicit trace id', async () => {
    const { client, rpc } = voidClient();
    await resolveMarkRecord({ client, channelId: CHANNEL, messageId: 'm1', traceId: 't1' });
    expect(rpc).toHaveBeenCalledWith('chat_mark_resolve', {
      p_message_id: 'm1',
      p_channel_id: CHANNEL,
      p_trace_id: 't1',
    });
  });

  it('reopen calls chat_mark_reopen with the explicit trace id', async () => {
    const { client, rpc } = voidClient();
    await reopenMarkRecord({ client, channelId: CHANNEL, messageId: 'm1', traceId: 't1' });
    expect(rpc).toHaveBeenCalledWith('chat_mark_reopen', {
      p_message_id: 'm1',
      p_channel_id: CHANNEL,
      p_trace_id: 't1',
    });
  });
});

describe('deleteMessagesRecord', () => {
  const ids = Array.from({ length: 250 }, (_, i) => `m${i}`);

  it('chunks at 100 ids per chat_message_delete call, in order', async () => {
    const { client, rpc } = voidClient();
    const onChunkDeleted = vi.fn();
    const result = await deleteMessagesRecord({
      client,
      channelId: CHANNEL,
      messageIds: ids,
      traceId: 't1',
      onChunkDeleted,
    });
    expect(result).toEqual({ ok: true, deleted: ids });
    const sizes = rpc.mock.calls.map(
      (c) => ((c as unknown[])[1] as { p_message_ids: string[] }).p_message_ids.length,
    );
    expect(sizes).toEqual([100, 100, 50]);
    expect((rpc.mock.calls[0] as unknown[] | undefined)?.[0]).toBe('chat_message_delete');
    expect(onChunkDeleted).toHaveBeenCalledTimes(3);
    expect(chunkIds(['a', 'b', 'c'], 2)).toEqual([['a', 'b'], ['c']]);
  });

  it('stops at the first failing chunk and returns the proc message', async () => {
    const { client, rpc } = voidClient(2);
    const result = await deleteMessagesRecord({
      client,
      channelId: CHANNEL,
      messageIds: ids,
      traceId: 't1',
    });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      ok: false,
      deleted: ids.slice(0, 100),
      message: 'marked messages cannot be deleted',
    });
  });
});

describe('sendMessageRecord forward', () => {
  it('maps forwardedFromMessageId to p_forwarded_from_message_id with no reply', async () => {
    const { client, rpc } = makeClient({ data: row, error: null });
    await sendMessageRecord({
      client,
      id: ID,
      channelId: CHANNEL,
      traceId: 'trace-1',
      body: 'hello',
      attachmentAssetIds: [],
      replyToMessageId: null,
      forwardedFromMessageId: 'source-1',
    });
    expect(rpc).toHaveBeenCalledWith('chat_message_send', {
      p_id: ID,
      p_channel_id: CHANNEL,
      p_trace_id: 'trace-1',
      p_body: 'hello',
      p_forwarded_from_message_id: 'source-1',
    });
  });

  it('omits the forward param on a plain send', async () => {
    const { client, rpc } = makeClient({ data: row, error: null });
    await sendMessageRecord({
      client,
      id: ID,
      channelId: CHANNEL,
      traceId: 'trace-1',
      body: 'hello',
      attachmentAssetIds: [],
      forwardedFromMessageId: null,
    });
    const args = rpc.mock.calls[0]![1] as Record<string, unknown>;
    expect(args).not.toHaveProperty('p_forwarded_from_message_id');
  });
});

describe('clearChannelRecord', () => {
  it('calls chat_channel_clear with the channel and the explicit trace id, under an abort signal', async () => {
    const { client, rpc, abortSignal } = makeClient({ data: null, error: null });
    const result = await clearChannelRecord({ client, channelId: CHANNEL, traceId: 'trace-9' });
    expect(rpc).toHaveBeenCalledWith('chat_channel_clear', {
      p_channel_id: CHANNEL,
      p_trace_id: 'trace-9',
    });
    expect(abortSignal).toHaveBeenCalledOnce();
    expect(result).toEqual({ ok: true });
  });

  it('surfaces a proc error as a WriteResult without throwing', async () => {
    const { client } = makeClient({ data: null, error: { message: 'denied' } });
    expect(await clearChannelRecord({ client, channelId: CHANNEL, traceId: 't' })).toEqual({
      ok: false,
      message: 'denied',
    });
  });

  it('aborts after the timeout', async () => {
    vi.useFakeTimers();
    try {
      const { client } = makeClient('hang');
      const pending = clearChannelRecord({
        client,
        channelId: CHANNEL,
        traceId: 't',
        timeoutMs: 50,
      });
      await vi.advanceTimersByTimeAsync(50);
      const result = await pending;
      expect(result.ok).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('editMessageRecord', () => {
  const edited = { ...row, body: 'fixed', edited_at: '2026-09-22T10:05:00+00:00' };

  it('always sends the full mention list as p_mentions', async () => {
    const X = '11111111-1111-4111-8111-111111111111';
    const { client, rpc } = makeClient({ data: edited, error: null });
    await editMessageRecord({
      client,
      channelId: CHANNEL,
      messageId: ID,
      body: `hi @[${X}]`,
      mentions: [X],
      traceId: 't',
    });
    expect(rpc).toHaveBeenCalledWith(
      'chat_message_edit',
      expect.objectContaining({ p_mentions: [X] }),
    );
  });

  it('calls chat_message_edit with typed args and the explicit trace id, returning the row', async () => {
    const { client, rpc, abortSignal } = makeClient({ data: edited, error: null });
    const result = await editMessageRecord({
      client,
      channelId: CHANNEL,
      messageId: ID,
      body: '  fixed  ',
      mentions: [],
      traceId: 'trace-1',
    });
    expect(rpc).toHaveBeenCalledWith('chat_message_edit', {
      p_message_id: ID,
      p_channel_id: CHANNEL,
      p_body: 'fixed',
      p_mentions: [],
      p_trace_id: 'trace-1',
    });
    expect(abortSignal).toHaveBeenCalledOnce();
    expect(result).toEqual({ ok: true, row: edited });
  });

  it('returns the proc error, and an empty response as an error', async () => {
    const failed = await editMessageRecord({
      client: makeClient({ data: null, error: { message: 'edit window has closed' } }).client,
      channelId: CHANNEL,
      messageId: ID,
      body: 'x',
      mentions: [],
      traceId: 't',
    });
    expect(failed).toEqual({ ok: false, reason: 'error', message: 'edit window has closed' });
    const empty = await editMessageRecord({
      client: makeClient({ data: null, error: null }).client,
      channelId: CHANNEL,
      messageId: ID,
      body: 'x',
      mentions: [],
      traceId: 't',
    });
    expect(empty.ok).toBe(false);
  });

  it('aborts after 10 s (or the override) and reports a timeout', async () => {
    vi.useFakeTimers();
    try {
      const pending = editMessageRecord({
        client: makeClient('hang').client,
        channelId: CHANNEL,
        messageId: ID,
        body: 'x',
        mentions: [],
        traceId: 't',
        timeoutMs: 50,
      });
      await vi.advanceTimersByTimeAsync(60);
      const result = await pending;
      expect(!result.ok && result.reason).toBe('timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('maps the proc errors to the user copy', () => {
    expect(editFailureCopy('edit window has closed')).toBe('Edit window has closed (15 min)');
    expect(editFailureCopy('marked messages cannot be edited')).toBe(
      "Marked messages can't be edited",
    );
    expect(editFailureCopy('deleted messages cannot be edited')).toBe("Couldn't edit. Try again.");
    expect(editFailureCopy('AbortError')).toBe("Couldn't edit. Try again.");
  });
});

describe('D2: deleteFailureCopy', () => {
  it('maps each proc refusal to its line, like edit', () => {
    expect(
      deleteFailureCopy('only your own messages from the last 30 minutes can be deleted'),
    ).toBe('Delete window has closed (30 min)');
    expect(deleteFailureCopy('marked messages cannot be deleted')).toBe(
      "Marked messages can't be deleted",
    );
  });

  it('anything else, transport errors included, reads the generic line (never raw text)', () => {
    for (const raw of [
      'TypeError: Failed to fetch',
      'AbortError: signal is aborted without reason',
      'not a member of this chat',
      'select between 1 and 100 messages',
      '',
    ]) {
      expect(deleteFailureCopy(raw)).toBe("Couldn't delete. Try again.");
    }
  });
});

describe('sendMessageRecord mentions', () => {
  const X = '11111111-1111-4111-8111-111111111111';

  it('passes p_mentions when the body mentions someone, omits it when empty', async () => {
    const withMention = makeClient({ data: row, error: null });
    await sendMessageRecord({
      client: withMention.client,
      id: ID,
      channelId: CHANNEL,
      traceId: 't',
      body: `hi @[${X}]`,
      attachmentAssetIds: [],
      mentions: [X],
    });
    expect(withMention.rpc).toHaveBeenCalledWith(
      'chat_message_send',
      expect.objectContaining({ p_body: `hi @[${X}]`, p_mentions: [X] }),
    );
    const none = makeClient({ data: row, error: null });
    await sendMessageRecord({
      client: none.client,
      id: ID,
      channelId: CHANNEL,
      traceId: 't',
      body: 'hi',
      attachmentAssetIds: [],
      mentions: [],
    });
    expect(none.rpc.mock.calls[0]?.[1]).not.toHaveProperty('p_mentions');
  });
});
