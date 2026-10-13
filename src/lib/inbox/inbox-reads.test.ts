import { describe, expect, it } from 'vitest';
import type { Database } from '@srtdio/schemas';
import {
  enrichNewRows,
  fetchInboxSince,
  fetchInboxUnreadCount,
  fetchUnreadMentionCount,
} from '@/lib/inbox/inbox-reads';
import { toastFromEnriched, type InboxRow } from '@/lib/inbox/inbox-live';

type InboxEntryRow = Database['public']['Tables']['inbox_entries']['Row'];

function row(over: Partial<InboxEntryRow>): InboxEntryRow {
  return {
    id: 'e1',
    user_id: 'u1',
    workspace_id: 'w1',
    event_type: 'comment',
    entity_type: 'post',
    entity_id: 'p1',
    scope: 'posts',
    scope_key: null,
    tier: 'active',
    payload: {},
    read_at: null,
    snoozed_until: null,
    actor_user_id: null,
    email_sent_at: null,
    deleted_at: null,
    created_at: '2026-06-14T00:00:00.000Z',
    ...over,
  };
}

// A hand-rolled PostgREST-ish fake: every builder method returns the same
// chainable, which resolves (it is a thenable) to the canned result for its table.
// Covers select (with the head/count option), eq/is/or/gt/order/limit for the
// reads and select/in for the enrichment joins. The select option carrying a count
// drains the canned `count`; otherwise the canned `data` is returned.
type QueryResult = {
  data?: Record<string, unknown>[] | null;
  count?: number | null;
  error: { message: string } | null;
};

interface FakeBuilder extends PromiseLike<QueryResult> {
  select(cols?: string, opts?: unknown): FakeBuilder;
  eq(col: string, val: unknown): FakeBuilder;
  is(col: string, val: unknown): FakeBuilder;
  or(filter: string): FakeBuilder;
  not(col: string, op: string, val: unknown): FakeBuilder;
  gt(col: string, val: unknown): FakeBuilder;
  order(col: string, opts?: unknown): FakeBuilder;
  limit(n: number): FakeBuilder;
  in(col: string, vals: readonly unknown[]): FakeBuilder;
}

function builder(result: QueryResult): FakeBuilder {
  const self: FakeBuilder = {
    select: () => self,
    eq: () => self,
    is: () => self,
    or: () => self,
    not: () => self,
    gt: () => self,
    order: () => self,
    limit: () => self,
    in: () => self,
    then(onfulfilled, onrejected) {
      return Promise.resolve(result).then(onfulfilled, onrejected);
    },
  };
  return self;
}

function fakeClient(tables: Record<string, QueryResult>): Parameters<typeof fetchInboxSince>[0] {
  const client = {
    from(table: string): FakeBuilder {
      return builder(tables[table] ?? { data: [], error: null });
    },
  };
  return client as unknown as Parameters<typeof fetchInboxSince>[0];
}

const okData = (data: Record<string, unknown>[]): QueryResult => ({ data, error: null });
const okCount = (count: number): QueryResult => ({ count, error: null });
const err = (message: string): QueryResult => ({ data: null, count: null, error: { message } });

const inboxRow = (over: Partial<InboxEntryRow>): Record<string, unknown> =>
  row(over) as unknown as Record<string, unknown>;

describe('fetchInboxUnreadCount', () => {
  it('returns the HEAD count', async () => {
    const client = fakeClient({ inbox_entries: okCount(7) });
    const res = await fetchInboxUnreadCount(client, {
      workspaceId: 'w1',
      userId: 'u1',
      nowIso: '2026-06-14T00:00:00.000Z',
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toBe(7);
  });

  it('treats a null count as zero', async () => {
    const client = fakeClient({ inbox_entries: { count: null, error: null } });
    const res = await fetchInboxUnreadCount(client, {
      workspaceId: 'w1',
      userId: 'u1',
      nowIso: '2026-06-14T00:00:00.000Z',
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toBe(0);
  });

  it('fails closed on a query error', async () => {
    const client = fakeClient({ inbox_entries: err('count boom') });
    const res = await fetchInboxUnreadCount(client, {
      workspaceId: 'w1',
      userId: 'u1',
      nowIso: '2026-06-14T00:00:00.000Z',
    });
    expect(res.ok).toBe(false);
  });
});

describe('fetchUnreadMentionCount', () => {
  it('returns the HEAD count', async () => {
    const client = fakeClient({ inbox_entries: okCount(3) });
    const res = await fetchUnreadMentionCount(client, {
      workspaceId: 'w1',
      userId: 'u1',
      nowIso: '2026-06-14T00:00:00.000Z',
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toBe(3);
  });

  it('treats a null count as zero', async () => {
    const client = fakeClient({ inbox_entries: { count: null, error: null } });
    const res = await fetchUnreadMentionCount(client, {
      workspaceId: 'w1',
      userId: 'u1',
      nowIso: '2026-06-14T00:00:00.000Z',
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toBe(0);
  });

  it('fails closed on a query error', async () => {
    const client = fakeClient({ inbox_entries: err('mention count boom') });
    const res = await fetchUnreadMentionCount(client, {
      workspaceId: 'w1',
      userId: 'u1',
      nowIso: '2026-06-14T00:00:00.000Z',
    });
    expect(res.ok).toBe(false);
  });
});

describe('fetchInboxSince', () => {
  it('returns the raw rows', async () => {
    const client = fakeClient({
      inbox_entries: okData([inboxRow({ id: 'e-new' })]),
    });
    const res = await fetchInboxSince(client, {
      workspaceId: 'w1',
      userId: 'u1',
      sinceIso: '2026-06-14T00:00:00.000Z',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toHaveLength(1);
      expect(res.data[0]?.id).toBe('e-new');
    }
  });

  it('fails closed on a query error', async () => {
    const client = fakeClient({ inbox_entries: err('since boom') });
    const res = await fetchInboxSince(client, {
      workspaceId: 'w1',
      userId: 'u1',
      sinceIso: '2026-06-14T00:00:00.000Z',
    });
    expect(res.ok).toBe(false);
  });
});

describe('enrichNewRows', () => {
  const newRows: InboxRow[] = [
    row({
      id: 'e-comment',
      event_type: 'comment',
      entity_type: 'post',
      entity_id: 'p1',
      payload: { comment_id: 'c1' },
      created_at: '2026-06-14T13:00:00.000Z',
    }),
  ];

  it('resolves the lead actor, body and title via batched joins', async () => {
    const client = fakeClient({
      comments: okData([{ id: 'c1', author_user_id: 'u-alice', body: 'Ship it!' }]),
      posts: okData([{ id: 'p1', title: 'Q3 Launch' }]),
      users: okData([{ id: 'u-alice', display_name: 'Alice', avatar_url: 'https://cdn/a.png' }]),
    });
    const res = await enrichNewRows(client, newRows);
    expect(res.count).toBe(1);
    expect(res.lead).toEqual({
      eventType: 'comment',
      actorName: 'Alice',
      actorAvatarUrl: 'https://cdn/a.png',
      body: 'Ship it!',
      title: 'Q3 Launch',
      mentionNames: new Map(),
      toStage: null,
      reviewWithdrawn: false,
      reviewPrevious: null,
    });
  });

  it('carries a plan_review withdrawal so the live toast names it', async () => {
    const client = fakeClient({});
    const res = await enrichNewRows(client, [
      row({
        event_type: 'plan_review',
        entity_type: 'plan_item',
        entity_id: 'i1',
        actor_user_id: 'u-cy',
        payload: { side: 'client', status: 'waiting', withdrawn: true, previous: 'approved' },
      }),
    ]);
    expect(res.lead?.reviewWithdrawn).toBe(true);
    expect(res.lead?.reviewPrevious).toBe('approved');
    // The live reader resolves no actor for plan rows: the name-free wording.
    expect(toastFromEnriched(res)?.title).toBe('Slot approval withdrawn');
  });

  it('carries a stage_change lead toStage so the toast names the outcome', async () => {
    const client = fakeClient({ posts: okData([{ id: 'p1', title: 'Q3 Launch' }]) });
    for (const [to, label] of [
      ['approved', 'Post approved'],
      ['rejected', 'Post rejected'],
      ['parked', 'Post parked'],
      ['review', 'Post moved'],
    ]) {
      const res = await enrichNewRows(client, [
        row({ event_type: 'stage_change', payload: { from: 'review', to } }),
      ]);
      expect(res.lead?.toStage).toBe(to);
      expect(toastFromEnriched(res)?.title).toBe(label);
    }
  });

  const MANISHA = '0b9d7c1e-1f2a-4c3b-9d8e-7f6a5b4c3d2e';
  const RAHUL = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
  const mentionBody = `@[${MANISHA}] and @[${RAHUL}] can we post this today`;

  it('reads authors and mentioned ids in one batched profile read', async () => {
    const users: { cols: string; ids: unknown[] }[] = [];
    const client = {
      from(table: string) {
        if (table === 'users') {
          let cols = '';
          const b = {
            select: (c: string) => ((cols = c), b),
            in: (_col: string, ids: unknown[]) => {
              users.push({ cols, ids });
              return builder(
                okData([
                  { id: 'u-alice', display_name: 'Alice', avatar_url: null },
                  { id: MANISHA, display_name: 'Manisha', avatar_url: null },
                  { id: RAHUL, display_name: 'Rahul', avatar_url: null },
                ]),
              );
            },
          };
          return b;
        }
        if (table === 'comments')
          return builder(okData([{ id: 'c1', author_user_id: 'u-alice', body: mentionBody }]));
        if (table === 'posts') return builder(okData([{ id: 'p1', title: 'Q3 Launch' }]));
        return builder(okData([]));
      },
    } as unknown as Parameters<typeof enrichNewRows>[0];
    const res = await enrichNewRows(client, newRows);
    expect(users).toHaveLength(1);
    expect(users[0]?.ids).toEqual(['u-alice', MANISHA, RAHUL]);
    expect(res.lead?.actorName).toBe('Alice');
    expect(res.lead?.mentionNames).toEqual(
      new Map([
        [MANISHA, 'Manisha'],
        [RAHUL, 'Rahul'],
      ]),
    );
  });

  it('marks names unknown (null) when the profile read fails', async () => {
    const client = fakeClient({
      comments: okData([{ id: 'c1', author_user_id: 'u-alice', body: mentionBody }]),
      posts: okData([{ id: 'p1', title: 'Q3 Launch' }]),
      users: err('users down'),
    });
    const res = await enrichNewRows(client, newRows);
    expect(res.lead?.mentionNames).toBeNull();
    expect(res.lead?.title).toBe('Q3 Launch');
  });

  it('marks names unknown (null) when the profile read times out', async () => {
    const hung = {
      from(table: string) {
        if (table === 'users') {
          const never: PromiseLike<QueryResult> = { then: () => new Promise(() => undefined) };
          const b = { select: () => b, in: () => never };
          return b;
        }
        if (table === 'comments')
          return builder(okData([{ id: 'c1', author_user_id: 'u-alice', body: mentionBody }]));
        return builder(okData([{ id: 'p1', title: 'Q3 Launch' }]));
      },
    } as unknown as Parameters<typeof enrichNewRows>[0];
    const res = await enrichNewRows(hung, newRows, 10);
    expect(res.lead?.mentionNames).toBeNull();
    expect(res.lead?.actorName).toBeNull();
  });

  it('degrades a failed sub-query to null without failing the batch', async () => {
    const client = fakeClient({
      comments: err('comments down'),
      posts: okData([{ id: 'p1', title: 'Q3 Launch' }]),
    });
    const res = await enrichNewRows(client, newRows);
    expect(res.count).toBe(1);
    expect(res.lead?.actorName).toBeNull();
    expect(res.lead?.body).toBeNull();
    expect(res.lead?.title).toBe('Q3 Launch');
  });

  it('returns a null lead for an empty batch', async () => {
    const res = await enrichNewRows(fakeClient({}), []);
    expect(res).toEqual({ count: 0, lead: null });
  });
});

describe('bell rows stay out of the Activity counts', () => {
  function recording(): {
    client: Parameters<typeof fetchInboxUnreadCount>[0];
    calls: { method: string; args: unknown[] }[];
  } {
    const calls: { method: string; args: unknown[] }[] = [];
    const self: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'is', 'or', 'not', 'gt', 'order', 'limit', 'in']) {
      self[method] = (...args: unknown[]) => {
        calls.push({ method, args });
        return self;
      };
    }
    self.then = (onfulfilled: (v: QueryResult) => unknown) =>
      Promise.resolve({ count: 0, error: null }).then(onfulfilled);
    const client = { from: () => self };
    return { client: client as unknown as Parameters<typeof fetchInboxUnreadCount>[0], calls };
  }
  const params = { workspaceId: 'w1', userId: 'u1', nowIso: '2026-10-03T00:00:00.000Z' };

  it('the Activity badge excludes reminder, scheduled and chat mention rows', async () => {
    const { client, calls } = recording();
    await fetchInboxUnreadCount(client, params);
    expect(calls).toContainEqual({
      method: 'not',
      args: [
        'event_type',
        'in',
        '(reminder,scheduled_sent,scheduled_failed,plan_opened,plan_deleted,plan_date_changed,plan_updated,plan_review,plan_comment,task_changed,task_due)',
      ],
    });
    expect(calls).toContainEqual({
      method: 'or',
      args: ['event_type.neq.mention,entity_type.is.null,entity_type.neq.chat_channel'],
    });
  });

  it('the Mentions count keeps post and brief mentions only', async () => {
    const { client, calls } = recording();
    await fetchUnreadMentionCount(client, params);
    expect(calls).toContainEqual({ method: 'eq', args: ['event_type', 'mention'] });
    expect(calls).toContainEqual({
      method: 'or',
      args: ['event_type.neq.mention,entity_type.is.null,entity_type.neq.chat_channel'],
    });
  });
});
