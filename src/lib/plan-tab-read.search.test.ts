// Plan search regression: ONE plan_search call, then the matched plans in ONE
// plan_bundle_read by id (p_plan_ids), both under the search's one trace id;
// nothing under 2 characters; a newer query aborts the call in flight (the
// shared runner); results sort Newest first, Oldest first or Name.
import { describe, expect, it } from 'vitest';
import type { Client } from '@srtdio/rpc';
import {
  PLAN_SORT_DEFAULT,
  PLAN_SORT_OPTIONS,
  planSearchArgs,
  planSearchMatches,
  sanitizePlanSort,
  searchPlanTab,
  sortPlanBundles,
} from '@/lib/plan-tab-read';
import { createServerSearchRunner } from '@/lib/search/server-search';

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
  signal?: AbortSignal;
}

/** Answers per rpc name; 'pending' never answers. */
function rpcClient(answers: Record<string, unknown | 'pending'>) {
  const calls: RpcCall[] = [];
  const rpc = (fn: string, args: Record<string, unknown>) => {
    const call: RpcCall = { fn, args };
    calls.push(call);
    const answer = answers[fn];
    const builder = {
      setHeader: () => builder,
      abortSignal: (signal: AbortSignal) => {
        call.signal = signal;
        return builder;
      },
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        (answer === 'pending'
          ? new Promise<never>(() => {})
          : Promise.resolve({ data: answer ?? null, error: null })
        ).then(resolve, reject),
    };
    return builder;
  };
  return { client: { rpc } as unknown as Client, calls };
}

const plan = (id: string, title: string, startsOn: string) => ({
  id,
  workspace_id: 'w1',
  title,
  starts_on: startsOn,
  ends_on: startsOn,
  audience: 'client',
  created_by: null,
});
const item = (id: string, planId: string, title: string) => ({
  id,
  plan_id: planId,
  kind: 'concept',
  position: 0,
  title,
  description: null,
  post_id: null,
  created_at: '2026-10-01T00:00:00Z',
});

const BUNDLE = {
  timezone: 'UTC',
  plans: [plan('pl1', 'Diwali week', '2026-10-20'), plan('pl2', 'Autumn', '2026-10-01')],
  items: [item('i1', 'pl1', 'Diwali reel'), item('i2', 'pl2', 'Leaf reel')],
};

const SEARCH_ROWS = [
  { plan_id: 'pl1', item_id: null },
  { plan_id: 'pl1', item_id: 'i1' },
  { plan_id: 'pl2', item_id: 'i2' },
  { plan_id: 'pl1', item_id: 'i1' },
];

describe('Plan search (plan_search, then one plan_bundle_read)', () => {
  it('reads the matched plans in ONE batched bundle call, under one trace', async () => {
    const { client, calls } = rpcClient({ plan_search: SEARCH_ROWS, plan_bundle_read: BUNDLE });
    const result = await searchPlanTab(client, { workspaceId: 'w1', query: ' reel ' });
    expect(calls.map((c) => c.fn)).toEqual(['plan_search', 'plan_bundle_read']);
    expect(calls[0]?.args).toMatchObject({ p_workspace_id: 'w1', p_query: 'reel' });
    expect(calls[1]?.args).toMatchObject({ p_workspace_id: 'w1', p_plan_ids: ['pl1', 'pl2'] });
    expect(calls[1]?.args.p_trace_id).toBe(calls[0]?.args.p_trace_id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.bundles.map((b) => b.plan.id)).toEqual(['pl1', 'pl2']);
    expect(result.data.matchedItems).toEqual({ pl1: ['i1'], pl2: ['i2'] });
  });

  it('no match: no bundle read', async () => {
    const { client, calls } = rpcClient({ plan_search: [] });
    const result = await searchPlanTab(client, { workspaceId: 'w1', query: 'zz' });
    expect(calls.map((c) => c.fn)).toEqual(['plan_search']);
    expect(result.ok && result.data.bundles).toEqual([]);
  });

  it('the runner sends nothing under 2 characters and aborts a call when the query changes', () => {
    const { client, calls } = rpcClient({ plan_search: 'pending' });
    const pending: Array<() => void> = [];
    const runner = createServerSearchRunner({
      fetch: (query, signal) => searchPlanTab(client, { workspaceId: 'w1', query }, signal),
      onChange: () => {},
      setTimer: (run) => pending.push(run),
      clearTimer: () => pending.splice(0),
    });
    const flush = (): void => pending.splice(0).forEach((run) => run());
    runner.setQuery('d');
    flush();
    expect(calls).toHaveLength(0);
    runner.setQuery('di');
    flush();
    expect(calls[0]?.args.p_query).toBe('di');
    expect(calls[0]?.signal?.aborted).toBe(false);
    runner.setQuery('diw');
    expect(calls[0]?.signal?.aborted).toBe(true);
  });

  it('planSearchArgs and planSearchMatches are pure', () => {
    expect(planSearchArgs({ workspaceId: 'w1', query: ' 50%_ ', traceId: 't' })).toEqual({
      p_workspace_id: 'w1',
      p_query: '50%_',
      p_trace_id: 't',
    });
    expect(planSearchMatches(SEARCH_ROWS)).toEqual({
      planIds: ['pl1', 'pl2'],
      matchedItems: { pl1: ['i1'], pl2: ['i2'] },
    });
  });
});

describe('Plan sort', () => {
  const bundles = [
    { plan: { id: 'b', title: 'beta', starts_on: '2026-10-05', ends_on: '2026-10-06' } },
    { plan: { id: 'a', title: 'Alpha', starts_on: '2026-10-20', ends_on: '2026-10-21' } },
    { plan: { id: 'c', title: 'gamma', starts_on: '2026-09-01', ends_on: '2026-09-02' } },
  ];

  it('offers Newest first, Oldest first and Name', () => {
    expect(PLAN_SORT_OPTIONS.map((o) => o.label)).toEqual(['Newest first', 'Oldest first', 'Name']);
    expect(sanitizePlanSort('due')).toBe(PLAN_SORT_DEFAULT);
  });

  it('orders by start date either way, or by name', () => {
    expect(sortPlanBundles(bundles, 'newest').map((b) => b.plan.id)).toEqual(['a', 'b', 'c']);
    expect(sortPlanBundles(bundles, 'oldest').map((b) => b.plan.id)).toEqual(['c', 'b', 'a']);
    expect(sortPlanBundles(bundles, 'name').map((b) => b.plan.id)).toEqual(['a', 'b', 'c']);
  });
});
