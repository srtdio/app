import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }));

import type { Client } from '@srtdio/rpc';
import {
  CATCH_UP_PAGE,
  bodyOf,
  threadReplyIds,
  threadReplyRows,
  topLevelComments,
} from '@/lib/catch-up/body';
import { cardOf, entry } from '@/lib/catch-up/test-fixtures';

const at = (h: number): string => `2026-11-08T${String(h).padStart(2, '0')}:00:00.000Z`;

const comment = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  entity_id: 'p1',
  author_user_id: 'u1',
  body: `Text ${id}`,
  created_at: at(9),
  parent_comment_id: null as string | null,
  ledger_batch_id: null,
  ledger_seq: null,
  resolved_at: null,
  closed_at: null,
  accepted_at: null,
  ...over,
});

const parts = (over: Partial<Parameters<typeof bodyOf>[1]> = {}): Parameters<typeof bodyOf>[1] => ({
  workspaceId: 'w1',
  side: 'agency',
  zone: 'UTC',
  post: {
    title: 'Winter coat reel',
    caption: '',
    format: 'text',
    target_date: null,
    stage: 'review',
    deleted_at: null,
  },
  brief: undefined,
  planItem: undefined,
  planTitle: new Map(),
  pictures: { images: [], video: null },
  comments: [],
  planComments: [],
  counts: new Map(),
  ...over,
});

describe('catch up: a reply inside a thread on its card (10 Nov 2026)', () => {
  const root = comment('c1', { body: 'Can we open on the coat?' });
  const reply = comment('r4', {
    parent_comment_id: 'c1',
    created_at: at(11),
    author_user_id: 'u2',
  });
  const card = cardOf(entry({ id: 'e4', created_at: at(11), payload: { comment_id: 'r4' } }));

  it('asks only for unread comment ids not drawn as top-level rows', () => {
    expect(threadReplyIds([card], [root])).toEqual(['r4']);
    expect(threadReplyIds([card], [root, reply])).toEqual([]);
  });

  it('draws the reply as a message row with its root, never a "Commented on" line', () => {
    const body = bodyOf(
      card,
      parts({
        comments: [root],
        threadReplies: [reply],
        threadRoots: new Map([['c1', root]]),
        counts: new Map([['c1', 4]]),
      }),
    );
    if (body === 'skip' || body === 'error') throw new Error('body');
    expect(body.rows.map((r) => [r.kind, r.id])).toEqual([
      ['message', 'c1'],
      ['message', 'r4'],
    ]);
    const row = body.rows[1];
    if (row?.kind !== 'message') throw new Error('row');
    expect(row.threadRoot?.id).toBe('c1');
    expect(row.threadRoot?.text).toBe('Can we open on the coat?');
    expect(row.threadRoot?.replyCount).toBe(4);
    expect(body.rows.some((r) => r.kind === 'event')).toBe(false);
    expect(body.firstNewId).toBe('r4');
  });

  it('a reply whose root is gone draws no message row (the entry keeps its line)', () => {
    expect(threadReplyRows('w1', { threadReplies: [reply], counts: new Map() })).toEqual([]);
  });
});

describe('catch up: top-level comments read per entity', () => {
  it('one query per entity, each with its own page, so a busy item never crowds another out', async () => {
    const calls: Array<{ entity?: string; limit?: number }> = [];
    const rowsOf: Record<string, unknown[]> = {
      busy: Array.from({ length: 50 }, (_, i) => comment(`b${i}`, { entity_id: 'busy' })),
      quiet: [comment('q1', { entity_id: 'quiet' })],
    };
    const client = {
      from: () => {
        const call: { entity?: string; limit?: number } = {};
        calls.push(call);
        const b = {
          select: () => b,
          is: () => b,
          order: () => b,
          eq: (_col: string, id: string) => {
            call.entity = id;
            return b;
          },
          limit: async (n: number) => {
            call.limit = n;
            return { data: (rowsOf[call.entity ?? ''] ?? []).slice(0, n), error: null };
          },
        };
        return b;
      },
    } as unknown as Client;
    const got = await topLevelComments(client, ['busy', 'quiet']);
    expect(calls).toEqual([
      { entity: 'busy', limit: CATCH_UP_PAGE },
      { entity: 'quiet', limit: CATCH_UP_PAGE },
    ]);
    expect(got.error).toBeNull();
    expect(got.data.filter((c) => c.entity_id === 'busy')).toHaveLength(CATCH_UP_PAGE);
    expect(got.data.filter((c) => c.entity_id === 'quiet')).toHaveLength(1);
  });
});
