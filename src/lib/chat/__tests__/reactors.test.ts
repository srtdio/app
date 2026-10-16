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

  it('a reactor whose name has not loaded renders nothing extra, never Former member', () => {
    expect(model.rows.find((r) => r.userId === 'ghost')?.name).toBe('');
  });

  it('only a reactor a read confirmed is not a current member reads Former member', () => {
    const gone = groupReactors(rows, 'me', profileOf, (id) => id === 'ghost');
    expect(gone.rows.find((r) => r.userId === 'ghost')?.name).toBe('Former member');
    expect(gone.rows.find((r) => r.userId === 'a')?.name).toBe('Asha');
  });
});
