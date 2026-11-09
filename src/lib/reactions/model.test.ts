import { describe, expect, it } from 'vitest';
import {
  NO_REACTIONS,
  applyOp,
  groupByTarget,
  reactionChipLabel,
  summarize,
  toggleOp,
  type ReactionRow,
} from '@/lib/reactions/model';

const ME = 'me';
const row = (emoji: string, userId: string, createdAt: string, targetId = 'c1'): ReactionRow => ({
  targetId,
  userId,
  emoji,
  createdAt,
});

describe('reactions model', () => {
  it('summarizes one chip per emoji in order of first reaction, with count and mine', () => {
    const rows = [
      row('❤️', 'b', '2026-11-09T10:02:00Z'),
      row('👍', 'a', '2026-11-09T10:01:00Z'),
      row('👍', ME, '2026-11-09T10:03:00Z'),
    ];
    expect(summarize(rows, ME)).toEqual([
      { emoji: '👍', count: 2, mine: true },
      { emoji: '❤️', count: 1, mine: false },
    ]);
  });

  it('keeps arrival order on a tie (stable)', () => {
    const at = '2026-11-09T10:00:00Z';
    expect(summarize([row('🙏', 'a', at), row('✅', 'b', at)], null).map((r) => r.emoji)).toEqual([
      '🙏',
      '✅',
    ]);
  });

  it('no rows: the shared empty array (no chip row renders)', () => {
    expect(summarize([], ME)).toBe(NO_REACTIONS);
  });

  it('toggle: add when not mine, remove when mine', () => {
    const rows = [row('👍', ME, '2026-11-09T10:00:00Z')];
    expect(toggleOp(rows, ME, '👍')).toBe('remove');
    expect(toggleOp(rows, ME, '❤️')).toBe('add');
  });

  it('applyOp adds then removes the viewer row; the rollback restores the chips', () => {
    const start = [row('👍', 'a', '2026-11-09T10:00:00Z')];
    const added = applyOp(start, { targetId: 'c1', me: ME, emoji: '👍', op: 'add', at: 'x' });
    expect(summarize(added, ME)).toEqual([{ emoji: '👍', count: 2, mine: true }]);
    const back = applyOp(added, { targetId: 'c1', me: ME, emoji: '👍', op: 'remove', at: 'x' });
    expect(summarize(back, ME)).toEqual([{ emoji: '👍', count: 1, mine: false }]);
    expect(applyOp(start, { targetId: 'c1', me: ME, emoji: '❤️', op: 'remove', at: 'x' })).toBe(
      start,
    );
  });

  it('groups rows per asked target, empty for a target with none', () => {
    const grouped = groupByTarget([row('👍', 'a', 't', 'c2')], ['c1', 'c2']);
    expect(grouped.get('c1')).toEqual([]);
    expect(grouped.get('c2')?.length).toBe(1);
  });

  it('labels a chip for screen readers', () => {
    expect(reactionChipLabel({ emoji: '👍', count: 3, mine: true })).toBe('👍 3, you reacted');
    expect(reactionChipLabel({ emoji: '👍', count: 1, mine: false })).toBe('👍 1');
  });
});
