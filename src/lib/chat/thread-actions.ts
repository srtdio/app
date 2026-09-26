// Small, framework-free pieces of the thread's actions, kept out of the React
// hook so their ordering and guards are unit-tested directly: the in-flight
// guard that makes a double-tapped Retry send once, the reaction flow that only
// signals peers after the record holds the reaction, and the settle step that
// records a send failure in the per-channel outbox (and logs it) whatever
// channel is open by the time the proc answers.

import type { ChannelOutbox } from '@/lib/chat/chat-store';
import type { SendOutcome } from '@/lib/chat/send-flow';
import type { WriteResult } from '@/lib/chat/record';

/** One-at-a-time guard keyed by message id. */
export interface InFlightGuard {
  /** True (and marks it busy) when the id is idle; false when already in flight. */
  tryStart: (id: string) => boolean;
  finish: (id: string) => void;
}

export function createInFlightGuard(): InFlightGuard {
  const busy = new Set<string>();
  return {
    tryStart: (id) => {
      if (busy.has(id)) return false;
      busy.add(id);
      return true;
    },
    finish: (id) => {
      busy.delete(id);
    },
  };
}

/**
 * Record a reaction, then signal peers only once the record accepted it. A
 * failed record reverts the optimistic change and sends no signal.
 */
export async function recordThenSignal(steps: {
  record: () => Promise<WriteResult>;
  signal: () => Promise<unknown>;
  onRecordFailed: (message: string) => void;
  onSignalFailed: (error: unknown) => void;
}): Promise<void> {
  const result = await steps.record();
  if (!result.ok) {
    steps.onRecordFailed(result.message);
    return;
  }
  try {
    await steps.signal();
  } catch (error) {
    steps.onSignalFailed(error);
  }
}

/**
 * Settle a failed send: always log it and mark the outbox entry failed (so the
 * bubble and its Retry survive a channel switch); only touch the visible list
 * when that channel is still open.
 */
export function settleSendFailure(input: {
  outcome: Extract<SendOutcome, { ok: false }>;
  id: string;
  channelId: string;
  traceId: string;
  outbox: ChannelOutbox;
  isOpen: () => boolean;
  markFailed: () => void;
  logError: (message: string, context: Record<string, unknown>) => void;
}): void {
  input.logError('chat: message record failed', {
    trace_id: input.traceId,
    message_id: input.id,
    channel_id: input.channelId,
    reason: input.outcome.reason,
    error: input.outcome.error,
  });
  input.outbox.setState(input.channelId, input.id, 'failed');
  if (input.isOpen()) input.markFailed();
}
