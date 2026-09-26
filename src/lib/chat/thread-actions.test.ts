import { describe, expect, it, vi } from 'vitest';
import { createChannelOutbox, type Outbox } from '@/lib/chat/chat-store';
import {
  createInFlightGuard,
  recordThenSignal,
  settleSendFailure,
} from '@/lib/chat/thread-actions';

describe('createInFlightGuard (Retry double-tap)', () => {
  it('lets one retry through per id until it finishes', () => {
    const guard = createInFlightGuard();
    expect(guard.tryStart('m1')).toBe(true);
    expect(guard.tryStart('m1')).toBe(false);
    expect(guard.tryStart('m2')).toBe(true);
    guard.finish('m1');
    expect(guard.tryStart('m1')).toBe(true);
  });
});

describe('recordThenSignal (reaction)', () => {
  it('sends the cmd signal only after the rpc resolved ok', async () => {
    const order: string[] = [];
    let resolveRecord: (v: { ok: true }) => void = () => {};
    const signal = vi.fn(async () => {
      order.push('signal');
    });
    const flow = recordThenSignal({
      record: () =>
        new Promise((resolve) => {
          resolveRecord = (v) => {
            order.push('record');
            resolve(v);
          };
        }),
      signal,
      onRecordFailed: vi.fn(),
      onSignalFailed: vi.fn(),
    });
    await Promise.resolve();
    expect(signal).not.toHaveBeenCalled();
    resolveRecord({ ok: true });
    await flow;
    expect(order).toEqual(['record', 'signal']);
  });

  it('sends no signal and reverts when the rpc fails', async () => {
    const signal = vi.fn();
    const onRecordFailed = vi.fn();
    await recordThenSignal({
      record: async () => ({ ok: false, message: 'denied' }),
      signal,
      onRecordFailed,
      onSignalFailed: vi.fn(),
    });
    expect(signal).not.toHaveBeenCalled();
    expect(onRecordFailed).toHaveBeenCalledWith('denied');
  });

  it('reports a failed signal without throwing', async () => {
    const onSignalFailed = vi.fn();
    await recordThenSignal({
      record: async () => ({ ok: true }),
      signal: async () => {
        throw new Error('agora down');
      },
      onRecordFailed: vi.fn(),
      onSignalFailed,
    });
    expect(onSignalFailed).toHaveBeenCalledOnce();
  });
});

describe('settleSendFailure (channel switch)', () => {
  const failed = { ok: false as const, reason: 'timeout' as const, error: 'aborted' };

  it('logs and marks the outbox failed even after the user switched channels', () => {
    const holder = { current: {} as Outbox };
    const outbox = createChannelOutbox(holder);
    outbox.put('a', {
      id: 'm1',
      text: 'hi',
      local: { attachments: [], sharedPostIds: [], reply: null },
      state: 'sending',
    });
    const logError = vi.fn();
    const markFailed = vi.fn();
    settleSendFailure({
      outcome: failed,
      id: 'm1',
      channelId: 'a',
      traceId: 't1',
      outbox,
      isOpen: () => false,
      markFailed,
      logError,
    });
    expect(logError).toHaveBeenCalledWith(
      'chat: message record failed',
      expect.objectContaining({ trace_id: 't1', message_id: 'm1', channel_id: 'a' }),
    );
    expect(markFailed).not.toHaveBeenCalled();
    // Back on channel a, the failed bubble and its Retry payload are still there.
    expect(outbox.entries('a')[0]?.state).toBe('failed');
  });

  it('marks the visible bubble when the channel is still open', () => {
    const outbox = createChannelOutbox({ current: {} });
    const markFailed = vi.fn();
    settleSendFailure({
      outcome: failed,
      id: 'm1',
      channelId: 'a',
      traceId: 't1',
      outbox,
      isOpen: () => true,
      markFailed,
      logError: vi.fn(),
    });
    expect(markFailed).toHaveBeenCalledOnce();
  });
});
