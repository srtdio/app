import { beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '@srtdio/schemas';
import {
  enrichNewRows,
  fetchInboxSince,
  fetchInboxUnreadCount,
  fetchNewestInboxAt,
  fetchUnreadMentionCount,
} from '@/lib/inbox/inbox-reads';
import { toastFromEnriched, type InboxRow } from '@/lib/inbox/inbox-live';
import { resetMentionNames } from '@/lib/chat/mentions';
import { noteServerDate, resetServerClock } from '@/lib/chat/bounded-window';

beforeEach(() => resetMentionNames());

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
  gte(col: string, val: unknown): FakeBuilder;
  lt(col: string, val: unknown): FakeBuilder;
  lte(col: string, val: unknown): FakeBuilder;
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
    gte: () => self,
    lt: () => self,
    lte: () => self,
    order: () => self,
    limit: () => self,
    in: () => self,
    then(onfulfilled, onrejected) {
      return Promise.resolve(result).then(onfulfilled, onrejected);
    },
  };
  return self;
}

// Every readable profile is a current member unless the test says otherwise.
function fakeClient(tables: Record<string, QueryResult>): Parameters<typeof fetchInboxSince>[0] {
  const members: QueryResult = tables.workspace_members ?? {
    data: (tables.users?.data ?? []).map((u) => ({ user_id: u.id, role: 'agency' })),
    error: null,
  };
  const client = {
    from(table: string): FakeBuilder {
      if (table === 'workspace_members') return builder(members);
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
      expect(res.data.rows.map((r) => r.id)).toContain('e-new');
      expect(res.data.activityCount).toBe(1);
    }
  });

  it('filters bell rows before the cap and counts exactly beyond 10', async () => {
    const calls: {
      ors: string[];
      nots: unknown[];
      eqs: [string, unknown][];
      limit: number | null;
      opts: unknown;
    }[] = [];
    const activity = Array.from({ length: 10 }, (_, i) =>
      inboxRow({ id: `a${i}`, created_at: `2026-06-14T01:00:${String(10 + i)}.000Z` }),
    );
    const client = {
      from() {
        const call = {
          ors: [] as string[],
          nots: [] as unknown[],
          eqs: [] as [string, unknown][],
          limit: null as number | null,
          opts: null as unknown,
        };
        calls.push(call);
        const self = {
          select: (_c: string, opts?: unknown) => ((call.opts = opts), self),
          eq: (c: string, v: unknown) => (call.eqs.push([c, v]), self),
          is: () => self,
          gt: () => self,
          lt: () => self,
          or: (f: string) => (call.ors.push(f), self),
          not: (...a: unknown[]) => (call.nots.push(a), self),
          order: () => self,
          limit: (n: number) => ((call.limit = n), self),
          then(onfulfilled: (v: QueryResult) => unknown) {
            const bell = call.eqs.some(([c, v]) => c === 'entity_type' && v === 'chat_channel');
            return Promise.resolve(
              bell
                ? {
                    data: [
                      inboxRow({ id: 'm1', event_type: 'mention', entity_type: 'chat_channel' }),
                    ],
                    error: null,
                  }
                : { data: activity, count: 37, error: null },
            ).then(onfulfilled);
          },
        };
        return self;
      },
    } as unknown as Parameters<typeof fetchInboxSince>[0];
    const res = await fetchInboxSince(client, { workspaceId: 'w1', userId: 'u1', sinceIso: 'x' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.activityCount).toBe(37);
    expect(res.data.rows).toHaveLength(11);
    // The activity read drops the old bell rows in the query itself, before its limit.
    const act = calls.find((c) => c.nots.length > 0);
    expect(act?.ors.length).toBeGreaterThan(0);
    expect(act?.opts).toEqual({ count: 'exact' });
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
      verb: 'commented',
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
    // The actor has no readable profile: a former member, never a raw id.
    expect(toastFromEnriched(res)?.title).toBe('Former member withdrew slot approval');
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
        if (table === 'workspace_members')
          return builder(
            okData([
              { user_id: 'u-alice', role: 'agency' },
              { user_id: MANISHA, role: 'client' },
            ]),
          );
        return builder(okData([]));
      },
    } as unknown as Parameters<typeof enrichNewRows>[0];
    const res = await enrichNewRows(client, newRows);
    expect(users).toHaveLength(1);
    expect(users[0]?.ids).toEqual(['u-alice', MANISHA, RAHUL]);
    expect(res.lead?.actorName).toBe('Alice');
    // Rahul's profile reads but he is no longer a member: "Former member".
    expect(res.lead?.mentionNames).toEqual(
      new Map([
        [MANISHA, '@Manisha'],
        [RAHUL, '@Former member'],
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

  it('a removed member reads "Former member" in the toast, never their real name', async () => {
    const client = fakeClient({
      comments: okData([{ id: 'c1', author_user_id: 'u-gone', body: 'hi' }]),
      posts: okData([{ id: 'p1', title: 'Q3 Launch' }]),
      users: okData([{ id: 'u-gone', display_name: 'Eve Real', avatar_url: 'https://cdn/e.png' }]),
      workspace_members: okData([]),
    });
    const res = await enrichNewRows(client, newRows);
    const spec = toastFromEnriched(res);
    expect(spec?.title).toBe('Former member commented on Q3 Launch');
    expect(spec?.actorAvatarUrl).toBeNull();
    expect(JSON.stringify(spec)).not.toContain('Eve');
  });

  it('an uncached current member resolves by the batched read (no placeholder)', async () => {
    const client = fakeClient({
      comments: okData([{ id: 'c1', author_user_id: 'u-new', body: 'hi' }]),
      posts: okData([{ id: 'p1', title: 'Q3 Launch' }]),
      users: okData([{ id: 'u-new', display_name: 'Nia Roy', avatar_url: null }]),
    });
    expect(toastFromEnriched(await enrichNewRows(client, newRows))?.title).toBe(
      'Nia Roy commented on Q3 Launch',
    );
  });

  it('counts exactly from total and groups every row by its own actor', async () => {
    const rows: InboxRow[] = [
      row({
        id: 'r1',
        event_type: 'stage_change',
        actor_user_id: 'u-a',
        payload: { to: 'approved' },
        created_at: '2026-06-14T02:00:00.000Z',
      }),
      row({
        id: 'r2',
        event_type: 'stage_change',
        actor_user_id: 'u-b',
        payload: { to: 'approved' },
        created_at: '2026-06-14T01:00:00.000Z',
      }),
    ];
    const client = fakeClient({
      posts: okData([{ id: 'p1', title: 'Q3 Launch' }]),
      users: okData([
        { id: 'u-a', display_name: 'Asha Rao', avatar_url: 'https://cdn/a.png' },
        { id: 'u-b', display_name: 'Bina', avatar_url: null },
      ]),
    });
    const res = await enrichNewRows(client, rows, undefined, 2);
    const spec = toastFromEnriched(res);
    expect(spec?.title).toBe('Asha Rao and 1 other approved on Q3 Launch');
    expect(spec?.actorAvatarUrl).toBe('https://cdn/a.png');
  });
});

describe('merged counts: the Notifications badge and the Mentions chip count every row', () => {
  function recording(): {
    client: Parameters<typeof fetchInboxUnreadCount>[0];
    calls: { method: string; args: unknown[] }[];
  } {
    const calls: { method: string; args: unknown[] }[] = [];
    const self: Record<string, unknown> = {};
    for (const method of [
      'select',
      'eq',
      'is',
      'or',
      'not',
      'gt',
      'gte',
      'lt',
      'lte',
      'order',
      'limit',
      'in',
    ]) {
      self[method] = (...args: unknown[]) => {
        calls.push({ method, args });
        return self;
      };
    }
    self.then = (onfulfilled: (v: QueryResult) => unknown) =>
      Promise.resolve({ count: 7, error: null }).then(onfulfilled);
    const client = { from: () => self };
    return { client: client as unknown as Parameters<typeof fetchInboxUnreadCount>[0], calls };
  }
  const params = { workspaceId: 'w1', userId: 'u1', nowIso: '2026-10-03T00:00:00.000Z' };
  const SNOOZE_OR = `snoozed_until.is.null,snoozed_until.lte.${params.nowIso}`;

  it('the badge counts every unread, non-deleted, non-snoozed row: the old bell rows too', async () => {
    const { client, calls } = recording();
    const res = await fetchInboxUnreadCount(client, params);
    expect(res).toEqual({ ok: true, data: 7 });
    expect(calls).toEqual([
      { method: 'select', args: ['id', { count: 'exact', head: true }] },
      { method: 'eq', args: ['workspace_id', 'w1'] },
      { method: 'eq', args: ['user_id', 'u1'] },
      { method: 'is', args: ['read_at', null] },
      { method: 'is', args: ['deleted_at', null] },
      { method: 'or', args: [SNOOZE_OR] },
    ]);
    // No event_type or entity filter: reminders, scheduled sends, plan and
    // task alerts and chat mentions all count.
    expect(calls.some((c) => c.method === 'not')).toBe(false);
  });

  it('the Mentions count includes chat mentions (event_type mention, any entity)', async () => {
    const { client, calls } = recording();
    await fetchUnreadMentionCount(client, params);
    expect(calls).toContainEqual({ method: 'eq', args: ['event_type', 'mention'] });
    expect(calls.filter((c) => c.method === 'or')).toEqual([{ method: 'or', args: [SNOOZE_OR] }]);
    expect(calls.some((c) => c.method === 'not')).toBe(false);
    expect(calls.some((c) => c.args[0] === 'entity_type')).toBe(false);
  });
});

describe('fix 28: fetchNewestInboxAt seeds the live mark from the server clock', () => {
  // The partition bounds' now: a Supabase response's Date header.
  beforeEach(() => {
    resetServerClock();
    noteServerDate(new Date().toUTCString());
  });

  function recording(result: QueryResult) {
    const calls: { method: string; args: unknown[] }[] = [];
    const tables: string[] = [];
    const self: Record<string, unknown> = {};
    for (const method of [
      'select',
      'eq',
      'is',
      'or',
      'not',
      'gt',
      'gte',
      'lt',
      'lte',
      'order',
      'limit',
      'in',
    ]) {
      self[method] = (...args: unknown[]) => {
        calls.push({ method, args });
        return self;
      };
    }
    self.then = (onfulfilled: (v: QueryResult) => unknown) =>
      Promise.resolve(result).then(onfulfilled);
    const client = {
      from: (table: string) => {
        tables.push(table);
        return self;
      },
    };
    return { client: client as unknown as Parameters<typeof fetchNewestInboxAt>[0], calls, tables };
  }
  const params = { workspaceId: 'w1', userId: 'u1' };

  it('reads one row: the newest created_at for the user in the workspace', async () => {
    const { client, calls, tables } = recording(
      okData([{ created_at: '2026-10-20T11:00:00.000Z' }]),
    );
    const res = await fetchNewestInboxAt(client, params);
    expect(res).toEqual({ ok: true, data: '2026-10-20T11:00:00.000Z' });
    expect(tables).toEqual(['inbox_entries']);
    expect(calls).toEqual([
      { method: 'select', args: ['created_at'] },
      { method: 'eq', args: ['workspace_id', 'w1'] },
      { method: 'eq', args: ['user_id', 'u1'] },
      // Both partition-key bounds: the last 30 days up to the server's now plus a minute.
      { method: 'gte', args: ['created_at', expect.any(String)] },
      { method: 'lt', args: ['created_at', expect.any(String)] },
      { method: 'order', args: ['created_at', { ascending: false }] },
      { method: 'limit', args: [1] },
    ]);
  });

  it('an empty inbox is null; a failed read is an error, never a device-clock guess', async () => {
    const empty = await fetchNewestInboxAt(recording(okData([])).client, params);
    expect(empty).toEqual({ ok: true, data: null });
    const failed = await fetchNewestInboxAt(recording(err('boom')).client, params);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.message).toContain('boom');
  });
});
