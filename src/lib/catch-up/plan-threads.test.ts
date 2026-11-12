import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }));
vi.mock('@/lib/people-names', () => ({
  resolvePeople: vi.fn(async () => undefined),
  personName: () => null,
  personAvatar: () => null,
}));
vi.mock('@/lib/catch-up/reads', () => ({
  readCatchUpChat: vi.fn(async (_c: unknown, _w: string, leads: { id: string }[]) => {
    const msg = (id: string, at: string) => ({
      id,
      senderId: 'u2',
      senderName: 'Maya',
      senderAvatarUrl: null,
      createdAt: at,
      text: `Text ${id}`,
    });
    return new Map(
      leads.map((l) => [
        l.id,
        {
          root: msg('m-root', '2026-11-08T09:00:00.000Z'),
          messages: [msg('m-r1', '2026-11-08T10:00:00.000Z')],
          firstNewId: 'm-r1',
          threadName: 'Coat reel',
          latestReplyId: 'm-r1',
          replyCounts: new Map(),
          hasOlder: false,
        },
      ]),
    );
  }),
}));

import type { Client } from '@srtdio/rpc';
import {
  bodyOf,
  planThreadReplyRows,
  readCatchUpBodies,
  readCatchUpThread,
  type CatchUpMessageRow,
} from '@/lib/catch-up/body';
import { cardOf, entry } from '@/lib/catch-up/test-fixtures';

const at = (h: number): string => `2026-11-08T${String(h).padStart(2, '0')}:00:00.000Z`;

const planComment = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  item_id: 'i1',
  author_user_id: 'u1' as string | null,
  body: `Text ${id}`,
  created_at: at(9),
  visibility: 'everyone',
  parent_comment_id: null as string | null,
  ...over,
});

const planParts = (
  over: Partial<Parameters<typeof bodyOf>[1]> = {},
): Parameters<typeof bodyOf>[1] => ({
  workspaceId: 'w1',
  side: 'agency',
  zone: 'UTC',
  post: undefined,
  brief: undefined,
  planItem: {
    title: 'Winter drop',
    description: null,
    target_date: null,
    plan_id: null,
    show_to_client: true,
    deleted_at: null,
  },
  planTitle: new Map(),
  pictures: { images: [], video: null },
  comments: [],
  planComments: [],
  counts: new Map(),
  ...over,
});

const planCard = (scopeKey: string | null) =>
  cardOf(
    entry({
      id: 'e1',
      event_type: 'plan_comment',
      entity_type: 'plan_item',
      entity_id: 'i1',
      scope_key: scopeKey,
      created_at: at(9),
      payload: { comment_id: 'pc1' },
    }),
  );

describe('catch up: every message is tappable (C2)', () => {
  it('plan item and idea cards open threads, main rows carry their reply counts', () => {
    for (const card of [planCard('plan-1'), planCard('bank')]) {
      expect(['plan-item', 'idea']).toContain(card.kind);
      const body = bodyOf(
        card,
        planParts({
          planComments: [planComment('pc1')],
          counts: new Map([['pc1', 3]]),
        }),
      );
      if (body === 'skip' || body === 'error') throw new Error('body');
      expect(body.threads).toBe(true);
      const row = body.rows.find((r) => r.id === 'pc1');
      if (row?.kind !== 'message') throw new Error('row');
      expect(row.replyCount).toBe(3);
    }
  });

  it('an unread plan reply draws as a message row with its root', () => {
    const root = planComment('pc1');
    const reply = planComment('pr1', { parent_comment_id: 'pc1', created_at: at(11) });
    const rows = planThreadReplyRows('w1', {
      planThreadReplies: [reply],
      planThreadRoots: new Map([['pc1', root]]),
      counts: new Map([['pc1', 2]]),
    });
    expect(rows.map((r) => r.id)).toEqual(['pr1']);
    expect(rows[0]?.threadRoot?.id).toBe('pc1');
    expect(rows[0]?.threadRoot?.replyCount).toBe(2);
    expect(planThreadReplyRows('w1', { planThreadReplies: [reply], counts: new Map() })).toEqual(
      [],
    );
  });

  it('a chat thread card opens threads and carries its root as cardRoot', async () => {
    const base = cardOf(entry({ id: 'e9', created_at: at(10) }));
    const card = {
      ...base,
      key: 'thread:ch1:m-root',
      kind: 'chat-thread' as const,
      entityId: 'ch1',
      threadRootId: 'm-root',
    };
    const done = { data: [], error: null };
    const builder: Record<string, unknown> = {};
    for (const m of ['select', 'in', 'is', 'eq', 'order', 'limit', 'lt'])
      builder[m] = () => builder;
    builder.then = (ok: (v: typeof done) => unknown) => Promise.resolve(done).then(ok);
    const client = { from: () => builder } as unknown as Client;
    const got = await readCatchUpBodies(client, {
      workspaceId: 'w1',
      items: [card],
      side: 'agency',
    });
    const body = got.get(card.key);
    if (body === undefined || body === 'skip' || body === 'error') throw new Error('body');
    expect(body.threads).toBe(true);
    expect(body.cardRoot?.id).toBe('m-root');
    expect(body.rows[0]?.id).toBe('m-root');
  });

  it("readCatchUpThread 'plan' reads plan_item_comments replies of the root, oldest first", async () => {
    const calls: Array<[string, ...unknown[]]> = [];
    const builder: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'is', 'order']) {
      builder[m] = (...args: unknown[]) => {
        calls.push([m, ...args]);
        return builder;
      };
    }
    builder.limit = async (n: number) => {
      calls.push(['limit', n]);
      return {
        data: [
          { id: 'pr1', author_user_id: 'u2', body: 'First', created_at: at(10) },
          { id: 'pr2', author_user_id: null, body: 'Second', created_at: at(11) },
        ],
        error: null,
      };
    };
    const client = {
      from: (table: string) => {
        calls.push(['from', table]);
        return builder;
      },
    } as unknown as Client;
    const root: CatchUpMessageRow = {
      kind: 'message',
      id: 'pc1',
      author: { id: 'u1', name: 'Maya', avatarUrl: null },
      createdAt: at(9),
      text: 'Root',
      replyCount: 2,
    };
    const got = await readCatchUpThread(client, { workspaceId: 'w1', kind: 'plan', root });
    expect(calls).toEqual([
      ['from', 'plan_item_comments'],
      ['select', 'id, author_user_id, body, created_at'],
      ['eq', 'parent_comment_id', 'pc1'],
      ['is', 'deleted_at', null],
      ['order', 'created_at', { ascending: true }],
      ['limit', 200],
    ]);
    expect(got?.root).toBe(root);
    expect(got?.replies.map((r) => [r.id, r.text])).toEqual([
      ['pr1', 'First'],
      ['pr2', 'Second'],
    ]);
  });
});
