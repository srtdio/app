// Activity search regression: ONE activity_search call per page (keyset on
// created_at, id; p_limit 50; a uuid_v7 p_trace_id), its rows through the
// feed's own mapEntry + batched joins (enrichInboxRows), nothing under 2
// characters, and a newer query aborting the call in flight (the shared
// runner). Activity has no sort: the feed and the search both read newest
// first (activity_search pages newest first; never reversed locally).
import { describe, expect, it } from 'vitest';
import type { Client } from '@srtdio/rpc';
import type { Database } from '@srtdio/schemas';
import {
  ACTIVITY_PAGE_SIZE,
  activityHitLine,
  activityLine,
  activitySearchArgs,
  mapEntry,
  searchActivityEntries,
} from '@/components/pages/activity/data';
import { createServerSearchRunner } from '@/lib/search/server-search';

type InboxEntryRow = Database['public']['Tables']['inbox_entries']['Row'];

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
  signal?: AbortSignal;
}

/** A query builder that answers every table read with no rows, whatever is chained. */
function emptyBuilder(): unknown {
  const answer = Promise.resolve({ data: [], error: null, count: 0 });
  const builder: unknown = new Proxy(
    {},
    {
      get: (_target, prop) =>
        prop === 'then'
          ? (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
              answer.then(resolve, reject)
          : () => builder,
    },
  );
  return builder;
}

function client(rows: InboxEntryRow[] | 'pending') {
  const calls: RpcCall[] = [];
  const rpc = (fn: string, args: Record<string, unknown>) => {
    const call: RpcCall = { fn, args };
    calls.push(call);
    const builder = {
      setHeader: () => builder,
      abortSignal: (signal: AbortSignal) => {
        call.signal = signal;
        return builder;
      },
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        (rows === 'pending'
          ? new Promise<never>(() => {})
          : Promise.resolve({ data: rows, error: null })
        ).then(resolve, reject),
    };
    return builder;
  };
  return { client: { rpc, from: () => emptyBuilder() } as unknown as Client, calls };
}

const ROW: InboxEntryRow = {
  id: 'e1',
  workspace_id: 'w1',
  user_id: 'u1',
  event_type: 'invite',
  entity_type: null,
  entity_id: null,
  scope: 'all',
  scope_key: null,
  tier: 'normal',
  created_at: '2026-10-01T10:00:00Z',
  read_at: null,
  snoozed_until: null,
  deleted_at: null,
  email_sent_at: null,
  payload: {},
  actor_user_id: null,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('Activity search (activity_search)', () => {
  it('names its args: query as typed (the proc escapes), page size, keyset cursor', () => {
    expect(
      activitySearchArgs({
        workspaceId: 'w1',
        query: ' 50%_ ',
        traceId: 't',
        cursor: { createdAt: '2026-10-01T10:00:00Z', id: 'e1' },
      }),
    ).toEqual({
      p_workspace_id: 'w1',
      p_query: '50%_',
      p_trace_id: 't',
      p_limit: ACTIVITY_PAGE_SIZE,
      p_before_created_at: '2026-10-01T10:00:00Z',
      p_before_id: 'e1',
    });
    expect(activitySearchArgs({ workspaceId: 'w1', query: 'ab', traceId: 't' })).not.toHaveProperty(
      'p_before_id',
    );
  });

  it('maps its rows through the feed path, one call with a uuid_v7 trace', async () => {
    const { client: c, calls } = client([ROW]);
    const result = await searchActivityEntries(c, 'w1', { query: 'invite' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.fn).toBe('activity_search');
    expect(calls[0]?.args.p_trace_id).toMatch(UUID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.map((item) => item.id)).toEqual(['e1']);
    expect(activityLine(result.data[0]!)).toBe(activityLine(mapEntry(ROW)));
  });

  it('sends nothing under 2 characters', async () => {
    const { client: c, calls } = client([ROW]);
    expect(await searchActivityEntries(c, 'w1', { query: 'i' })).toEqual({ ok: true, data: [] });
    expect(calls).toEqual([]);
  });

  it('the runner aborts the call in flight when the query changes', () => {
    const { client: c, calls } = client('pending');
    const pending: Array<() => void> = [];
    const runner = createServerSearchRunner({
      fetch: (query, signal) => searchActivityEntries(c, 'w1', { query }, signal),
      onChange: () => {},
      setTimer: (run) => pending.push(run),
      clearTimer: () => pending.splice(0),
    });
    const flush = (): void => pending.splice(0).forEach((run) => run());
    runner.setQuery('i');
    flush();
    expect(calls).toHaveLength(0);
    runner.setQuery('in');
    flush();
    expect(calls[0]?.signal?.aborted).toBe(false);
    runner.setQuery('inv');
    expect(calls[0]?.signal?.aborted).toBe(true);
  });
});

describe('activityHitLine (the palette words an activity hit as the feed does)', () => {
  it('reuses the feed line for the event type and subject', () => {
    expect(
      activityHitLine({
        id: 'e1',
        workspaceId: 'w1',
        eventType: 'comment',
        entityType: 'post',
        title: 'Launch reel',
        actorName: null,
      }),
    ).toBe('New comment on Launch reel');
    expect(
      activityHitLine({
        id: 'e1',
        workspaceId: 'w1',
        eventType: 'comment',
        entityType: 'post',
        title: 'Launch reel',
        actorName: 'Asha',
      }),
    ).toBe('Asha commented on Launch reel');
  });
});
