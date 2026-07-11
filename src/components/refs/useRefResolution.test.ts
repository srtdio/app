import { describe, expect, it } from 'vitest';
import type { Client } from '@srtdio/rpc';
import { resolveRef } from '@/components/refs/useRefResolution';

// A hand-rolled PostgREST-ish fake: every builder method returns the same
// chainable, and maybeSingle() resolves to the canned row for its table. No
// network, no Supabase. Covers from/select/eq/is/maybeSingle, the only surface
// the ref resolvers touch.
type SingleResult = { data: { id: string } | null; error: { message: string } | null };

interface FakeBuilder {
  select(cols?: string): FakeBuilder;
  eq(col: string, val: unknown): FakeBuilder;
  is(col: string, val: unknown): FakeBuilder;
  maybeSingle(): Promise<SingleResult>;
}

function builder(result: SingleResult): FakeBuilder {
  const self: FakeBuilder = {
    select: () => self,
    eq: () => self,
    is: () => self,
    maybeSingle: () => Promise.resolve(result),
  };
  return self;
}

function fakeClient(tables: Record<string, SingleResult>): Client {
  const client = {
    from(table: string): FakeBuilder {
      return builder(tables[table] ?? { data: null, error: null });
    },
  };
  return client as unknown as Client;
}

const row = (id: string): SingleResult => ({ data: { id }, error: null });
const empty: SingleResult = { data: null, error: null };

describe('resolveRef', () => {
  it('resolves a /p ref to the post id when the number is a post', async () => {
    const client = fakeClient({ workspaces: row('w1'), posts: row('post-1') });
    const res = await resolveRef(client, 'GBL-5', 'post');
    expect(res).toEqual({ status: 'resolved', id: 'post-1' });
  });

  it('resolves a /b ref to the brief id when the number is a brief', async () => {
    const client = fakeClient({ workspaces: row('w1'), briefs: row('brief-1') });
    const res = await resolveRef(client, 'GBL-5', 'brief');
    expect(res).toEqual({ status: 'resolved', id: 'brief-1' });
  });

  it('redirects a /p ref to /b when the number is actually a brief', async () => {
    const client = fakeClient({ workspaces: row('w1'), posts: empty, briefs: row('brief-1') });
    const res = await resolveRef(client, 'gbl-5', 'post');
    expect(res).toEqual({ status: 'redirect', to: '/b/gbl-5' });
  });

  it('redirects a /b ref to /p when the number is actually a post', async () => {
    const client = fakeClient({ workspaces: row('w1'), briefs: empty, posts: row('post-1') });
    const res = await resolveRef(client, 'gbl-5', 'brief');
    expect(res).toEqual({ status: 'redirect', to: '/p/gbl-5' });
  });

  it('is not-found for an unparseable ref (no lookups)', async () => {
    const client = fakeClient({});
    expect(await resolveRef(client, 'nonsense', 'post')).toEqual({ status: 'notfound' });
    expect(await resolveRef(client, undefined, 'brief')).toEqual({ status: 'notfound' });
  });

  it('is not-found when the workspace key is unknown or hidden by RLS', async () => {
    const client = fakeClient({ workspaces: empty });
    expect(await resolveRef(client, 'GBL-5', 'post')).toEqual({ status: 'notfound' });
  });

  it('is not-found when neither a post nor a brief carries the number', async () => {
    const client = fakeClient({ workspaces: row('w1'), posts: empty, briefs: empty });
    expect(await resolveRef(client, 'GBL-5', 'post')).toEqual({ status: 'notfound' });
  });

  it('is not-found on a transport error from the entity lookup', async () => {
    const client = fakeClient({
      workspaces: row('w1'),
      posts: { data: null, error: { message: 'boom' } },
    });
    expect(await resolveRef(client, 'GBL-5', 'post')).toEqual({ status: 'notfound' });
  });
});
