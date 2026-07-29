import { describe, expect, it } from 'vitest';
import type { Database } from '@srtdio/schemas';
import {
  enrichNewRows,
  fetchInboxSince,
  fetchInboxUnreadCount,
  fetchUnreadMentionCount,
} from '@/lib/inbox/inbox-reads';
import type { InboxRow } from '@/lib/inbox/inbox-live';

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
    });
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
