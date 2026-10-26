import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@srtdio/rpc';

// Plan tab requests: the read is ONE plan_bundle_read (one round, the zone
// comes with it: no workspaces read), a nav press starts it and the mount
// joins it, and a plan or post change marks the kept read stale (it still
// paints; the next read goes to the server).

vi.mock('@/lib/chat/viewer-role', () => ({
  resolveViewerSide: async () => 'agency',
}));

import {
  invalidatePlanTabReads,
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

const BUNDLE: Row = {
  timezone: 'UTC',
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
  items: [
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
  draft_rows: [],
  next_cursor: null,
  reviews: [],
  posts: [{ id: 'post-1', title: 'P', stage: 'review', format: null, target_date: null }],
  comment_counts: {},
  thumbs: { posts: {}, concepts: {} },
  also_in: null,
  loose_posts: [],
  any_plan: true,
  last_sent_at: null,
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
      hold(table, { data: [], error: null }).then(resolve);
    return q;
  };
  const rpc = (fn: string) =>
    hold(`rpc:${fn}`, { data: fn === 'plan_bundle_read' ? BUNDLE : [], error: null });
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
  onlyShared: false,
};

afterEach(() => {
  resetSessionReads();
});

describe('Plan tab read rounds', () => {
  it('one round, one request: plan_bundle_read', async () => {
    const { client, rounds } = gatedClient();
    const read = readSharedPlanTab(client, 'u1', ARGS);
    const seen = await rounds();
    const result = await read;
    expect(result.ok).toBe(true);
    expect(seen).toEqual([['rpc:plan_bundle_read']]);
    expect(result.ok && result.data.timeZone).toBe('UTC');
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

  it('a press with no zone known reads no workspaces row (the bundle carries the zone)', async () => {
    const { client, rounds } = gatedClient();
    const press = startPlanTabRead(client, { userId: 'u1', workspaceId: 'ws' }, false);
    const seen = await rounds();
    await press;
    expect(seen.flat()).toEqual(['rpc:plan_bundle_read']);
    expect(peekPlanTab('u1', { ...ARGS, range: null })).toBeDefined();
  });

  it('a plan or post change marks the kept read stale: it still paints, the next read asks', async () => {
    const { client, rounds } = gatedClient();
    const read = readSharedPlanTab(client, 'u1', ARGS);
    await rounds();
    await read;
    expect(peekPlanTab('u1', ARGS)).toBeDefined();
    invalidatePlanTabReads();
    expect(peekPlanTab('u1', ARGS)).toBeDefined();
    const again = readSharedPlanTab(client, 'u1', ARGS);
    expect(await rounds()).toEqual([['rpc:plan_bundle_read']]);
    expect((await again).ok).toBe(true);
  });
});
