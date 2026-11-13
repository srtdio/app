import { describe, expect, it } from 'vitest';
import { newLinePlaces, type NewLineRoot } from '@/lib/inbox/new-lines';
import { newMarksOf, type UnreadTarget } from '@/lib/inbox/unread-entities';

const ME = 'me';
const roots: NewLineRoot[] = [
  { id: 'old', authorId: 'priya', createdAt: '2026-08-22T05:00:00.000+00:00' },
  { id: 'mid', authorId: ME, createdAt: '2026-09-06T05:00:00.000+00:00' },
  { id: 'late', authorId: 'priya', createdAt: '2026-10-18T05:00:00.000+00:00' },
  { id: 'mine', authorId: ME, createdAt: '2026-11-13T04:00:00.000+00:00' },
  { id: 'today', authorId: 'priya', createdAt: '2026-11-13T04:40:00.123456+00:00' },
];

describe('New lines', () => {
  it('puts New above the first unread comment by someone else', () => {
    const places = newLinePlaces(roots, ME, {
      firstNewAt: '2026-11-13 04:40:00.123456+00',
      replyRootIds: [],
    });
    expect([...places]).toEqual([['today', 'New']]);
  });

  it('never puts New on my own comment, even at the unread time', () => {
    const places = newLinePlaces(roots, ME, {
      firstNewAt: '2026-11-13T04:00:00Z',
      replyRootIds: [],
    });
    expect(places.get('mine')).toBeUndefined();
    expect(places.get('today')).toBe('New');
  });

  it('puts New reply above an older comment whose thread got a reply (the 2-month case)', () => {
    const places = newLinePlaces(roots, ME, { firstNewAt: null, replyRootIds: ['old'] });
    expect([...places]).toEqual([['old', 'New reply']]);
  });

  it('shows both lines together, New reply first, New on the new comment', () => {
    const places = newLinePlaces(roots, ME, {
      firstNewAt: '2026-11-13T04:40:00.123Z',
      replyRootIds: ['old', 'today'],
    });
    expect([...places]).toEqual([
      ['old', 'New reply'],
      ['today', 'New'],
    ]);
  });

  it('draws nothing without marks', () => {
    expect(newLinePlaces(roots, ME, null).size).toBe(0);
    const bare: UnreadTarget = {
      commentId: 'c',
      planId: null,
      at: null,
      firstNewAt: null,
      replyRootIds: [],
    };
    expect(newMarksOf(bare)).toBeNull();
    expect(newMarksOf(undefined)).toBeNull();
  });
});
