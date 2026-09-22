import { describe, expect, it, vi } from 'vitest';
import { runSend, type SendFlowDeps, type SendInput } from '@/lib/chat/send-flow';
import type { ChatMessageRow } from '@/lib/chat/thread';

const ME = '11111111-1111-4111-8111-111111111111';
const CHANNEL = 'group__ws__g1';
const ID = '019935a0-0000-7000-8000-000000000001';

function row(over: Partial<ChatMessageRow> = {}): ChatMessageRow {
  return {
    id: ID,
    channel_id: CHANNEL,
    workspace_id: 'ws',
    sender_user_id: ME,
    body: 'hello',
    mentions: null,
    attachment_asset_ids: null,
    agora_event_id: null,
    created_at: '2026-09-22T10:00:00.123456+00:00',
    edited_at: null,
    deleted_at: null,
    ...over,
  };
}

function input(over: Partial<SendInput> = {}): SendInput {
  return {
    id: ID,
    channelId: CHANNEL,
    currentUserId: ME,
    traceId: 'trace-1',
    text: 'hello',
    local: { attachments: [], sharedPostIds: [], reply: null },
    ...over,
  };
}

function deps(over: Partial<SendFlowDeps> = {}): SendFlowDeps & {
  order: string[];
} {
  const order: string[] = [];
  return {
    order,
    recordMessage: vi.fn(async () => {
      order.push('record');
      return { ok: true as const, row: row() };
    }),
    publishLive: vi.fn(async () => {
      order.push('publish');
      return {};
    }),
    onLiveWarning: vi.fn(),
    ...over,
  };
}

describe('runSend', () => {
  it('records through chat_message_send BEFORE the Agora publish and renders the returned row', async () => {
    const d = deps();
    const outcome = await runSend(d, input());

    expect(d.order).toEqual(['record', 'publish']);
    expect(d.recordMessage).toHaveBeenCalledWith({
      id: ID,
      channelId: CHANNEL,
      traceId: 'trace-1',
      body: 'hello',
      attachmentAssetIds: [],
    });
    expect(d.publishLive).toHaveBeenCalledWith({
      id: ID,
      channelId: CHANNEL,
      text: 'hello',
      local: { attachments: [], sharedPostIds: [], reply: null },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.livePublished).toBe(true);
    // The bubble shows the SERVER created_at, never a local clock.
    expect(outcome.message.createdAt).toBe('2026-09-22T10:00:00.123456+00:00');
    expect(outcome.message.provisionalTime).toBe(false);
    expect(outcome.message.state).toBe('sent');
    expect(outcome.message.mine).toBe(true);
  });

  it('passes attachment version ids to the record', async () => {
    const d = deps();
    await runSend(
      d,
      input({
        text: '',
        local: {
          attachments: [{ assetId: 'v1', name: 'p.png', mime: 'image/png' }],
          sharedPostIds: [],
          reply: null,
        },
      }),
    );
    expect(d.recordMessage).toHaveBeenCalledWith(
      expect.objectContaining({ body: '', attachmentAssetIds: ['v1'] }),
    );
  });

  it('keeps the message sent when the live publish fails, and only warns', async () => {
    const d = deps({ publishLive: vi.fn().mockRejectedValue(new Error('agora down')) });
    const outcome = await runSend(d, input());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.livePublished).toBe(false);
    expect(outcome.message.state).toBe('sent');
    expect(d.onLiveWarning).toHaveBeenCalledWith(
      expect.objectContaining({ trace_id: 'trace-1', message_id: ID, error: 'Error: agora down' }),
    );
  });

  it('still sends with no live connection at all', async () => {
    const d = deps({ publishLive: undefined });
    const outcome = await runSend(d, input());
    expect(outcome.ok && outcome.livePublished).toBe(false);
    expect(outcome.ok && outcome.message.state).toBe('sent');
    expect(d.onLiveWarning).toHaveBeenCalledOnce();
  });

  it('reports failed (and never publishes) when the record write fails or times out', async () => {
    const failing = deps({
      recordMessage: vi
        .fn()
        .mockResolvedValue({ ok: false, reason: 'timeout', message: 'aborted' }),
    });
    const outcome = await runSend(failing, input());
    expect(outcome).toEqual({ ok: false, reason: 'timeout', error: 'aborted' });
    expect(failing.publishLive).not.toHaveBeenCalled();
  });

  it('retries with the SAME message id so the idempotent proc returns the one row', async () => {
    const recordMessage = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: 'timeout', message: 'aborted' })
      .mockResolvedValueOnce({ ok: true, row: row() });
    const d = deps({ recordMessage });

    const first = await runSend(d, input({ traceId: 'trace-1' }));
    const second = await runSend(d, input({ traceId: 'trace-2' }));

    expect(first.ok).toBe(false);
    expect(second.ok).toBe(true);
    expect(recordMessage.mock.calls[0]?.[0].id).toBe(ID);
    expect(recordMessage.mock.calls[1]?.[0].id).toBe(ID);
    // Each attempt is its own user action with its own trace id.
    expect(recordMessage.mock.calls[1]?.[0].traceId).toBe('trace-2');
  });
});
