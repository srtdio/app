import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@srtdio/rpc';

// Plan tab requests: the read waits three rounds (plans, the any-plan probe
// and the dated posts; then the items with plan_draft_rows in the SAME
// parallel round; then reviews, post stages and tiles together), a nav press
// starts it and the mount joins it, and the kept read is dropped when a plan
// or post changes.

vi.mock('@/lib/chat/viewer-role', () => ({
  resolveViewerSide: async () => 'agency',
}));

import {
  dropPlanTabReads,
  peekPlanTab,
  readSharedPlanTab,
  startPlanTabRead,
  type PlanTabReadArgs,
} from '@/lib/plan-tab-shared';
import { visibleRange } from '@/lib/plan-tab';
import { civilToday } from '@/lib/plan-week';
import { resetSessionReads } from '@/lib/session-read';

type Row = Record<string, unknown>;

const TODAY = civilToday(new Date(), 'UTC');

const TABLES: Record<string, Row[]> = {
  plans: [
    {
      id: 'plan-1',
      workspace_id: 'ws',
      title: 'Week',
      starts_on: TODAY,
      ends_on: TODAY,
      audience: 'team',
      created_by: null,
    },
  ],
  plan_items: [
    {
      id: 'item-1',
      plan_id: 'plan-1',
      kind: 'post',
      position: 0,
      title: null,
      description: null,
      post_id: 'post-1',
      created_at: '2026-10-01T00:00:00Z',
      target_date: null,
    },
  ],
  posts: [{ id: 'post-1', workspace_id: 'ws', title: 'P', stage: 'review', target_date: null }],
  plan_item_reviews: [],
  asset_attachments: [],
};

/**
 * A fake whose every request waits until the test releases its round, so the
 * rounds a read waits are counted exactly: each round is the set of requests
 * in flight at once.
 */
function gatedClient() {
  const pending: Array<{ label: string; release: () => void }> = [];
  const hold = <T>(label: string, value: T): Promise<T> =>
    new Promise<T>((resolve) => {
      pending.push({ label, release: () => resolve(value) });
    });
  const from = (table: string) => {
    const q: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in', 'is', 'gte', 'lte', 'order', 'abortSignal', 'range']) {
      q[m] = () => q;
    }
    q.limit = () => q;
    q.maybeSingle = () => q;
    q.then = (resolve: (v: unknown) => unknown) =>
      hold(table, { data: TABLES[table] ?? [], error: null }).then(resolve);
    return q;
  };
  const rpc = (fn: string) => hold(`rpc:${fn}`, { data: [], error: null });
  const client = { from, rpc } as unknown as Client;

  // Microtasks, then a macrotask: lazy imports and chained reads have queued.
  async function settle(): Promise<void> {
    for (let i = 0; i < 30; i += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let i = 0; i < 30; i += 1) await Promise.resolve();
  }
  /** Release round after round until nothing is waiting; the labels per round. */
  async function rounds(): Promise<string[][]> {
    const out: string[][] = [];
    await settle();
    while (pending.length > 0) {
      const batch = pending.splice(0);
      out.push(batch.map((b) => b.label).sort());
      for (const b of batch) b.release();
      await settle();
    }
    return out;
  }
  return { client, rounds };
}

const ARGS: PlanTabReadArgs = {
  workspaceId: 'ws',
  range: visibleRange('month', TODAY),
  timeZone: 'UTC',
  onlyShared: false,
};

afterEach(() => {
  resetSessionReads();
  dropPlanTabReads();
});

describe('Plan tab read rounds', () => {
  it('three rounds, with plan_draft_rows in the items round', async () => {
    const { client, rounds } = gatedClient();
    const read = readSharedPlanTab(client, 'u1', ARGS);
    const seen = await rounds();
    const result = await read;
    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(3);
    expect(seen[0]).toEqual(['plans', 'plans', 'posts']);
    expect(seen[1]).toEqual(['plan_items', 'rpc:plan_draft_rows']);
    expect(seen[2]).toEqual(['asset_attachments', 'plan_item_reviews', 'posts']);
  });
});

describe('Plan tab nav press', () => {
  it('a press starts the first render read; the mount joins it (no second request)', async () => {
    const { client, rounds } = gatedClient();
    // A laptop press with the zone known: the side is resolved (mocked), then
    // the month around today is read.
    const ctx = { userId: 'u1', workspaceId: 'ws', timeZone: 'UTC' };
    const press = startPlanTabRead(client, ctx, true);
    const first = await rounds();
    await press;
    const mount = readSharedPlanTab(client, 'u1', ARGS);
    const after = await rounds();
    expect((await mount).ok).toBe(true);
    expect(first.flat().length).toBeGreaterThan(0);
    // The mount added no request at all.
    expect(after).toEqual([]);
    expect(peekPlanTab('u1', ARGS)).toBeDefined();
  });

  it('a plan or post change drops the kept read', async () => {
    const { client, rounds } = gatedClient();
    const read = readSharedPlanTab(client, 'u1', ARGS);
    await rounds();
    await read;
    expect(peekPlanTab('u1', ARGS)).toBeDefined();
    dropPlanTabReads();
    expect(peekPlanTab('u1', ARGS)).toBeUndefined();
  });
});
