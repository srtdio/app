import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }));

import type { Client } from '@srtdio/rpc';
import { replyCountsFor, replyStatsOf } from '@/lib/catch-up/body';
import { tipText, wordsFamily } from '@/lib/catch-up/tip';

const r = (parent: string | null, author: string | null, at: string) => ({ parent, author, at });

describe('catch-up replies row data (10 Nov 2026)', () => {
  it('counts, up to 2 unique repliers newest first, and the newest reply time', () => {
    const { counts, info } = replyStatsOf([
      r('c1', 'u1', '2026-11-08T09:00:00Z'),
      r('c1', 'u2', '2026-11-08T11:00:00Z'),
      r('c1', 'u2', '2026-11-08T10:00:00Z'),
      r('c1', 'u3', '2026-11-08T08:00:00Z'),
      r('c2', 'u3', '2026-11-07T08:00:00Z'),
      r(null, 'u9', '2026-11-08T12:00:00Z'),
    ]);
    expect(counts.get('c1')).toBe(4);
    expect(counts.get('c2')).toBe(1);
    expect(info.get('c1')).toEqual({ repliers: ['u2', 'u1'], lastAt: '2026-11-08T11:00:00Z' });
    expect(info.get('c2')).toEqual({ repliers: ['u3'], lastAt: '2026-11-07T08:00:00Z' });
  });

  it('replyCountsFor: the same one query, two more columns, newest first', async () => {
    const calls: string[] = [];
    const chain = {
      select: (cols: string) => (calls.push(`select:${cols}`), chain),
      in: () => chain,
      is: () => chain,
      order: (col: string, o: { ascending: boolean }) => {
        calls.push(`order:${col}:${o.ascending}`);
        return Promise.resolve({
          error: null,
          data: [
            { parent_comment_id: 'c1', author_user_id: 'u2', created_at: '2026-11-08T11:00:00Z' },
            { parent_comment_id: 'c1', author_user_id: 'u1', created_at: '2026-11-08T09:00:00Z' },
          ],
        });
      },
    };
    const from = vi.fn(() => chain);
    const got = await replyCountsFor({ from } as unknown as Client, 'comments', ['c1']);
    expect(from).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([
      'select:parent_comment_id, author_user_id, created_at',
      'order:created_at:false',
    ]);
    expect(got.counts.get('c1')).toBe(2);
    expect(got.info.get('c1')?.repliers).toEqual(['u2', 'u1']);
  });

  it('no parents: no read', async () => {
    const from = vi.fn();
    const got = await replyCountsFor({ from } as unknown as Client, 'comments', []);
    expect(from).not.toHaveBeenCalled();
    expect(got.counts.size).toBe(0);
  });

  it('tip words by family and width', () => {
    expect(wordsFamily('post')).toBe('comment');
    expect(wordsFamily('idea')).toBe('comment');
    expect(wordsFamily('chat-main')).toBe('chat');
    expect(tipText('comment', false)).toBe('Tap a comment to reply to it.');
    expect(tipText('comment', true)).toBe('Click a comment to reply to it.');
    expect(tipText('chat', false)).toBe('Tap a message to reply in thread.');
  });
});
