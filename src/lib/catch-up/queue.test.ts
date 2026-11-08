import { describe, expect, it } from 'vitest';
import { buildCatchUpQueue, groupHeadEntry, heldEntries } from '@/lib/catch-up/queue';
import { entry } from '@/lib/catch-up/test-fixtures';

const NOW = Date.parse('2026-11-08T12:00:00.000Z');
const at = (h: number): string => `2026-11-08T${String(h).padStart(2, '0')}:00:00.000Z`;

describe('catch up queue', () => {
  const a = entry({ id: 'a', created_at: at(9) });
  const b = entry({ id: 'b', created_at: at(11) });
  const c = entry({ id: 'c', created_at: at(10) });
  const read = entry({ id: 'r', created_at: at(8), read_at: at(8) });
  const snoozed = entry({ id: 's', created_at: at(7), snoozed_until: '2026-11-09T00:00:00.000Z' });
  const otherWs = entry({ id: 'o', created_at: at(11), workspace_id: 'w2' });

  it('puts the tapped entry first (even a read one), then unread newest first', () => {
    const q = buildCatchUpQueue({ tapped: read, held: [a, b, c, read], nowMs: NOW });
    expect(q.map((i) => i.id)).toEqual(['r', 'b', 'c', 'a']);
  });

  it('leaves snoozed and read entries out, and other workspaces', () => {
    const q = buildCatchUpQueue({ tapped: a, held: [a, b, snoozed, read, otherWs], nowMs: NOW });
    expect(q.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('one card per notification: each entry once, never per group', () => {
    const q = buildCatchUpQueue({ tapped: b, held: [b, b, c], follow: [c], nowMs: NOW });
    expect(q.map((i) => i.id)).toEqual(['b', 'c']);
  });

  it('a group head opens its newest entry first, its other entries follow', () => {
    const head = groupHeadEntry([a, b, c]);
    expect(head?.id).toBe('b');
    const extra = entry({ id: 'x', created_at: at(11) });
    const q = buildCatchUpQueue({ tapped: b, follow: [a, c], held: [extra, a, b, c], nowMs: NOW });
    expect(q.map((i) => i.id)).toEqual(['b', 'c', 'a', 'x']);
  });

  it('the Catch up bar (nothing tapped) starts from the newest unread', () => {
    const q = buildCatchUpQueue({ tapped: null, held: [a, b, c], nowMs: NOW, workspaceId: 'w1' });
    expect(q[0]?.id).toBe('b');
  });

  it('is fixed when it opens: a later arrival is not in the built queue', () => {
    const held = [a, b];
    const q = buildCatchUpQueue({ tapped: a, held, nowMs: NOW });
    held.push(entry({ id: 'late', created_at: at(12) }));
    expect(q.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('heldEntries keeps the first copy of each id', () => {
    expect(heldEntries([a, b], undefined, [b, c]).map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });
});
