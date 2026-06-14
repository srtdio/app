import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@srtdio/schemas';
import { listActivity } from './data';

// A hand-rolled chainable double implementing only the methods listActivity
// uses (from/select/eq/is/order/limit/lt and from/select/in). Each builder is
// thenable, resolving to the canned result for its table. No real network.

interface Canned {
  data: unknown;
  error: { message: string } | null;
}

interface Builder {
  select: () => Builder;
  eq: () => Builder;
  is: () => Builder;
  order: () => Builder;
  limit: () => Builder;
  lt: () => Builder;
  in: () => Builder;
  then: (resolve: (value: Canned) => void) => void;
}

function builder(result: Canned): Builder {
  const self: Builder = {
    select: () => self,
    eq: () => self,
    is: () => self,
    order: () => self,
    limit: () => self,
    lt: () => self,
    in: () => self,
    then: (resolve) => resolve(result),
  };
  return self;
}

function makeClient(tables: Record<string, Canned>): SupabaseClient<Database> {
  const client = {
    from: (table: string) => builder(tables[table] ?? { data: [], error: null }),
  };
  return client as unknown as SupabaseClient<Database>;
}

const CREATED_AT = '2026-06-14T12:00:00.000Z';

describe('listActivity', () => {
  it('resolves a comment actorName via comments -> users and the title via posts', async () => {
    const client = makeClient({
      inbox_entries: {
        data: [
          {
            id: 'e1',
            event_type: 'comment',
            entity_type: 'post',
            entity_id: 'post1',
            scope: 'posts',
            tier: 'active',
            payload: { comment_id: 'c1' },
            read_at: null,
            snoozed_until: null,
            created_at: CREATED_AT,
          },
        ],
        error: null,
      },
      comments: { data: [{ id: 'c1', author_user_id: 'u1' }], error: null },
      posts: { data: [{ id: 'post1', title: 'My Post' }], error: null },
      users: { data: [{ id: 'u1', display_name: 'Alice' }], error: null },
    });

    const result = await listActivity(client, { workspaceId: 'ws1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [item] = result.data;
    expect(item?.actorName).toBe('Alice');
    expect(item?.entityTitle).toBe('My Post');
    expect(item?.entityType).toBe('post');
    expect(item?.entityId).toBe('post1');
  });

  it('resolves a stage_change toStage from payload.to with a null actor', async () => {
    const client = makeClient({
      inbox_entries: {
        data: [
          {
            id: 'e2',
            event_type: 'stage_change',
            entity_type: 'post',
            entity_id: 'post2',
            scope: 'posts',
            tier: 'urgent',
            payload: { to: 'approved', from: 'review' },
            read_at: null,
            snoozed_until: null,
            created_at: CREATED_AT,
          },
        ],
        error: null,
      },
      posts: { data: [{ id: 'post2', title: 'Stage Post' }], error: null },
    });

    const result = await listActivity(client, { workspaceId: 'ws1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [item] = result.data;
    expect(item?.actorName).toBeNull();
    expect(item?.toStage).toBe('approved');
    expect(item?.fromStage).toBe('review');
    expect(item?.entityTitle).toBe('Stage Post');
  });

  it('degrades to null fields when an enrichment sub-query errors', async () => {
    const client = makeClient({
      inbox_entries: {
        data: [
          {
            id: 'e3',
            event_type: 'comment',
            entity_type: 'post',
            entity_id: 'post3',
            scope: 'posts',
            tier: 'active',
            payload: { comment_id: 'c3' },
            read_at: null,
            snoozed_until: null,
            created_at: CREATED_AT,
          },
        ],
        error: null,
      },
      comments: { data: null, error: { message: 'boom' } },
      posts: { data: [{ id: 'post3', title: 'Still Resolves' }], error: null },
      users: { data: [{ id: 'u3', display_name: 'Bob' }], error: null },
    });

    const result = await listActivity(client, { workspaceId: 'ws1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [item] = result.data;
    expect(item?.actorName).toBeNull();
    expect(item?.entityTitle).toBe('Still Resolves');
  });

  it('returns a Result error (never throws) when the feed query fails', async () => {
    const client = makeClient({
      inbox_entries: { data: null, error: { message: 'denied' } },
    });
    const result = await listActivity(client, { workspaceId: 'ws1' });
    expect(result).toEqual({ ok: false, error: { code: 'unknown', message: 'denied' } });
  });
});
