import { describe, expect, it } from 'vitest';
import { ALL_TAB, groupReactors, rowsForTab } from '@/lib/chat/reactors';

const rows = [
  { userId: 'a', emoji: '👍', createdAt: '1' },
  { userId: 'me', emoji: '❤️', createdAt: '2' },
  { userId: 'b', emoji: '👍', createdAt: '3' },
  { userId: 'ghost', emoji: '😂', createdAt: '4' },
];
const names: Record<string, string> = { a: 'Asha', b: 'Bilal', me: 'Me Myself' };
const profileOf = (id: string) =>
  names[id] !== undefined ? { displayName: names[id] ?? '', avatarUrl: null } : undefined;

describe('T5 who reacted', () => {
  const model = groupReactors(rows, 'me', profileOf);

  it('All counts every reaction, then one chip per emoji with counts', () => {
    expect(model.tabs).toEqual([
      { key: ALL_TAB, emoji: null, count: 4 },
      { key: '👍', emoji: '👍', count: 2 },
      { key: '❤️', emoji: '❤️', count: 1 },
      { key: '😂', emoji: '😂', count: 1 },
    ]);
  });

  it('per-emoji tabs filter the rows', () => {
    expect(rowsForTab(model, '👍').map((r) => r.userId)).toEqual(['a', 'b']);
    expect(rowsForTab(model, ALL_TAB)).toHaveLength(4);
  });

  it('own row first, labelled You', () => {
    expect(model.rows[0]).toMatchObject({ userId: 'me', name: 'You', mine: true });
    expect(model.rows.filter((r) => r.mine)).toHaveLength(1);
  });

  it('an unread name renders nothing; only a confirmed former member reads "Former member"', () => {
    expect(model.rows.find((r) => r.userId === 'ghost')?.name).toBe('');
    const gone = groupReactors(
      [{ userId: 'ghost', emoji: '👍', createdAt: '2026-10-01T00:00:00Z' }],
      'me',
      () => undefined,
      (id) => id === 'ghost',
    );
    expect(gone.rows[0]?.name).toBe('Former member');
  });
});
