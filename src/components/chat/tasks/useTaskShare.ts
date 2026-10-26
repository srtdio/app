// Share the Tasks through Forward, so other chats get the standard
// "Forwarded" label. On the picker's confirm:
//   a) the snapshot text goes into the open chat through the thread's normal
//      send (the composer's path: outbox bubble, recorded, published), and the
//      share waits until that bubble is recorded under its real id;
//   b) that message goes to the other picked chats through the thread's own
//      forward (the long-press Forward), unchanged. The open chat, if picked,
//      is skipped there: it already has the message.
// A failed (a) leaves the bubble's own "Not sent · Retry" and forwards
// nothing; a failed (b) is the forward's own failure (the picker toasts the
// chat and stays open; a second Send re-forwards the same message, never a
// second snapshot here). No send path of its own.

import { useCallback, useEffect, useRef } from 'react';
import type { ChannelSummary } from '@/lib/chat-reads';
import type { ThreadMessage } from '@/lib/chat/thread';
import type { ForwardSendResult } from '@/components/chat/ForwardPicker';

/** The thread's pieces the share runs through. */
export interface TaskShareWiring {
  /** The chats the picker lists. */
  channels: readonly ChannelSummary[];
  /** The open chat (where the snapshot is sent). */
  openChannelId: string;
  /** The thread's loaded messages (the snapshot bubble shows up here). */
  messages: readonly ThreadMessage[];
  /** The thread's normal text send (the composer's). */
  send: (text: string) => void;
  /** The thread's forward (the long-press Forward's). */
  forward: (
    messages: readonly ThreadMessage[],
    targets: ChannelSummary[],
  ) => Promise<ForwardSendResult>;
  /** The snapshot text, built at confirm time. */
  snapshot: () => string;
  /** The snapshot bubble is in the thread (recorded or Not sent): bring it into view. */
  onShared: (messageId: string) => void;
}

type SnapshotState = { state: 'waiting' } | { state: 'sent' | 'failed'; message: ThreadMessage };

/**
 * Where the just-sent snapshot stands: the own message that was not loaded
 * before the send and carries its body. Waiting until it shows as recorded
 * (sent) or Not sent (failed). Pure.
 */
export function snapshotState(
  messages: readonly ThreadMessage[],
  before: ReadonlySet<string>,
  body: string,
): SnapshotState {
  const found = messages.find((m) => m.mine && !before.has(m.id) && m.body === body);
  if (found === undefined || found.state === 'sending') return { state: 'waiting' };
  return { state: found.state, message: found };
}

/** The forward's targets: the picked chats minus the open one. Pure. */
export function forwardTargets(
  targets: readonly ChannelSummary[],
  openChannelId: string,
): ChannelSummary[] {
  return targets.filter((t) => t.channelId !== openChannelId);
}

interface Waiter {
  before: ReadonlySet<string>;
  body: string;
  resolve: (result: SnapshotState) => void;
}

/**
 * The picker's onSend for a share. `reset` forgets the sent snapshot (call it
 * when the picker opens) so the next share sends a fresh one.
 */
export function useTaskShare(wiring: TaskShareWiring | null): {
  share: (targets: ChannelSummary[]) => Promise<ForwardSendResult>;
  reset: () => void;
} {
  const wiringRef = useRef(wiring);
  wiringRef.current = wiring;
  const waiterRef = useRef<Waiter | null>(null);
  // The snapshot this picker open already sent (a retried forward reuses it).
  const sentRef = useRef<ThreadMessage | null>(null);

  const messages = wiring?.messages;
  useEffect(() => {
    const waiter = waiterRef.current;
    if (waiter === null || messages === undefined) return;
    const now = snapshotState(messages, waiter.before, waiter.body);
    if (now.state === 'waiting') return;
    waiterRef.current = null;
    waiter.resolve(now);
  }, [messages]);

  // Leaving the chat (or unmounting) ends a wait: nothing is forwarded.
  const openChannelId = wiring?.openChannelId ?? null;
  useEffect(
    () => () => {
      const waiter = waiterRef.current;
      waiterRef.current = null;
      sentRef.current = null;
      waiter?.resolve({ state: 'waiting' });
    },
    [openChannelId],
  );

  const reset = useCallback((): void => {
    sentRef.current = null;
  }, []);

  const share = useCallback(async (targets: ChannelSummary[]): Promise<ForwardSendResult> => {
    const w = wiringRef.current;
    if (w === null || waiterRef.current !== null) return { ok: false, failed: null };
    let message = sentRef.current;
    if (message === null) {
      const body = w.snapshot().trim();
      const before = new Set(w.messages.map((m) => m.id));
      const settled = new Promise<SnapshotState>((resolve) => {
        waiterRef.current = { before, body, resolve };
      });
      w.send(body);
      const result = await settled;
      if (result.state === 'waiting') return { ok: false, failed: null };
      wiringRef.current?.onShared(result.message.id);
      if (result.state === 'failed') return { ok: true };
      message = result.message;
      sentRef.current = message;
    }
    const others = forwardTargets(targets, w.openChannelId);
    if (others.length === 0) return { ok: true };
    const forward = wiringRef.current?.forward ?? w.forward;
    return forward([message], others);
  }, []);

  return { share, reset };
}
