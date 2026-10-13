import { describe, expect, it } from 'vitest';
import {
  enqueue,
  hasUnlistedSaved,
  markSending,
  nextToSend,
  reconcile,
  removeEntry,
  retryEntry,
  settleCreate,
  type PendingTask,
} from '@/components/chat/tasks/add-queue';

function item(key: string, number: number): PendingTask {
  return { key, side: 'agency', title: `Item ${key}`, number, state: 'queued' };
}

function typed(...keys: string[]): PendingTask[] {
  return keys.reduce<PendingTask[]>((q, k, i) => enqueue(q, item(k, 12 + i)), []);
}

describe('add queue: typed order, one at a time', () => {
  it('sends the head only, then the next once it is saved', () => {
    let q = typed('a', 'b', 'c');
    expect(nextToSend(q)?.key).toBe('a');
    q = markSending(q, 'a');
    expect(nextToSend(q)).toBeNull();
    q = settleCreate(q, 'a', { ok: true, id: 'id-a' });
    expect(nextToSend(q)?.key).toBe('b');
    expect(q.map((p) => p.number)).toEqual([12, 13, 14]);
  });

  it('a failed create pauses the queue until Retry succeeds', () => {
    let q = settleCreate(markSending(typed('a', 'b'), 'a'), 'a', { ok: false });
    expect(q[0]?.state).toBe('failed');
    expect(nextToSend(q)).toBeNull();
    q = retryEntry(q, 'a');
    expect(nextToSend(q)?.key).toBe('a');
    q = settleCreate(markSending(q, 'a'), 'a', { ok: true, id: 'id-a' });
    expect(nextToSend(q)?.key).toBe('b');
  });

  it('removing the failed row lets the ones behind it go on; only failed rows can be removed', () => {
    let q = settleCreate(markSending(typed('a', 'b'), 'a'), 'a', { ok: false });
    expect(removeEntry(q, 'b')).toHaveLength(2);
    q = removeEntry(q, 'a');
    expect(q.map((p) => p.key)).toEqual(['b']);
    expect(nextToSend(q)?.key).toBe('b');
  });
});

describe('add queue: a created item is never dropped', () => {
  it('stays saved (with its id) until the list holds the row', () => {
    let q = settleCreate(markSending(typed('a'), 'a'), 'a', { ok: true, id: 'id-a' });
    expect(q[0]).toMatchObject({ state: 'saved', id: 'id-a' });
    // The follow-up read failed: nothing in the list yet, the row stays.
    expect(reconcile(q, new Set())).toBe(q);
    expect(hasUnlistedSaved(q)).toBe(true);
    // A later list read brings it: the entry leaves.
    q = reconcile(q, new Set(['id-a']));
    expect(q).toEqual([]);
    expect(hasUnlistedSaved(q)).toBe(false);
  });

  it('a saved head never blocks the next', () => {
    const q = settleCreate(markSending(typed('a', 'b'), 'a'), 'a', { ok: true, id: 'id-a' });
    expect(nextToSend(q)?.key).toBe('b');
  });
});
