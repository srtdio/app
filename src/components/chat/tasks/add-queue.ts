// The add queue: items typed into an add row, shown at once with their preview
// numbers and recorded one at a time in typed order (so the server numbers
// follow it). Pure, so every rule is unit-tested:
// - Only the first entry that is not yet saved may be sent; while it is sending
//   or has failed, everything behind it waits (a failure pauses the queue until
//   Retry succeeds or the user removes the failed row).
// - A created item is never dropped: once the server returns its id the entry
//   is `saved` and stays on screen until the list read brings that row.

import type { TaskPriority, TaskSide } from '@/lib/chat/tasks';

export type PendingState = 'queued' | 'sending' | 'failed' | 'saved';

/** An add shown before its server row is in the list. */
export interface PendingTask {
  key: string;
  side: TaskSide;
  title: string;
  /** The preview number it showed with. */
  number: number;
  /** Picked on the add row; P2 when absent. */
  priority?: TaskPriority;
  /** Picked on the add row (Today / Tomorrow at 9 pm); none when absent. */
  dueAt?: string | null;
  state: PendingState;
  /** The created task's id (saved only). */
  id?: string;
}

/** Append a typed item (queued). Pure. */
export function enqueue(queue: readonly PendingTask[], entry: PendingTask): PendingTask[] {
  return [...queue, { ...entry, state: 'queued' }];
}

/**
 * The entry to send now: the first one not yet saved, if it is queued. A
 * sending or failed head holds everything behind it. Pure.
 */
export function nextToSend(queue: readonly PendingTask[]): PendingTask | null {
  const head = queue.find((p) => p.state !== 'saved');
  return head !== undefined && head.state === 'queued' ? head : null;
}

function update(
  queue: readonly PendingTask[],
  key: string,
  change: (p: PendingTask) => PendingTask,
): PendingTask[] {
  return queue.map((p) => (p.key === key ? change(p) : p));
}

export function markSending(queue: readonly PendingTask[], key: string): PendingTask[] {
  return update(queue, key, (p) => ({ ...p, state: 'sending' }));
}

/** The record answered: saved with its id, or failed (the queue pauses). Pure. */
export function settleCreate(
  queue: readonly PendingTask[],
  key: string,
  result: { ok: true; id: string } | { ok: false },
): PendingTask[] {
  return update(queue, key, (p) =>
    result.ok ? { ...p, state: 'saved', id: result.id } : { ...p, state: 'failed' },
  );
}

/** Retry a failed entry: it goes back to the head of the line. Pure. */
export function retryEntry(queue: readonly PendingTask[], key: string): PendingTask[] {
  return update(queue, key, (p) => (p.state === 'failed' ? { ...p, state: 'queued' } : p));
}

/** The user removed a failed entry; the ones behind it go on. Pure. */
export function removeEntry(queue: readonly PendingTask[], key: string): PendingTask[] {
  return queue.filter((p) => !(p.key === key && p.state === 'failed'));
}

/** Saved entries whose row the list now holds leave the queue. Pure. */
export function reconcile(
  queue: readonly PendingTask[],
  taskIds: ReadonlySet<string>,
): PendingTask[] {
  const next = queue.filter(
    (p) => !(p.state === 'saved' && p.id !== undefined && taskIds.has(p.id)),
  );
  return next.length === queue.length ? (queue as PendingTask[]) : next;
}

/** Whether a saved entry still waits for its row (the list read is behind). Pure. */
export function hasUnlistedSaved(queue: readonly PendingTask[]): boolean {
  return queue.some((p) => p.state === 'saved');
}
