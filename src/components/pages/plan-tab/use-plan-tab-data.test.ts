import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@srtdio/rpc';
import type { PlanBundle } from '@/lib/chat/plans';
import type { PlanTabData } from '@/lib/plan-tab-read';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import { readNextPlanTabPage } from './use-plan-tab-data';
import { getPlanTabMore, setPlanTabMore } from './plan-tab-more';

function bundle(id: string, startsOn: string): PlanBundle {
  return {
    plan: {
      id,
      workspace_id: 'ws',
      title: id,
      starts_on: startsOn,
      ends_on: startsOn,
      audience: 'client',
      created_by: null,
    },
    items: [],
    reviews: [],
    postStages: {},
    postInfo: {},
  };
}

const SHOWN: PlanTabData = {
  bundles: [bundle('b', '2026-10-20'), bundle('c', '2026-10-27')],
  posts: [],
  thumbs: { posts: {}, concepts: {} },
  anyPlan: true,
  timeZone: 'UTC',
  nextCursor: { startsOn: '2026-10-20', id: 'b' },
};

/** The next page: one plan already shown (b) and one older (a); no cursor after it. */
function nextPageClient() {
  const rpc = vi.fn<(fn: string, args: Record<string, unknown>) => Promise<unknown>>(async () => ({
    data: {
      timezone: 'UTC',
      plans: [
        {
          id: 'a',
          workspace_id: 'ws',
          title: 'a',
          starts_on: '2026-10-13',
          ends_on: '2026-10-13',
          audience: 'client',
          created_by: null,
        },
        {
          id: 'b',
          workspace_id: 'ws',
          title: 'b',
          starts_on: '2026-10-20',
          ends_on: '2026-10-20',
          audience: 'client',
          created_by: null,
        },
      ],
      next_cursor: null,
      any_plan: true,
    },
    error: null,
  }));
  return { client: { rpc } as unknown as Client, rpc };
}

const ARGS = { workspaceId: 'ws', range: null, onlyShared: false };

describe('Load more (readNextPlanTabPage)', () => {
  it("passes the shown page's cursor as p_before_*, appends without duplicates", async () => {
    const { client, rpc } = nextPageClient();
    const res = await readNextPlanTabPage(client, ARGS, SHOWN);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0]?.[0]).toBe('plan_bundle_read');
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({
      p_workspace_id: 'ws',
      p_before_starts_on: '2026-10-20',
      p_before_id: 'b',
    });
    expect(res?.ok).toBe(true);
    if (res === null || !res.ok) return;
    expect(res.data.bundles.map((b) => b.plan.id)).toEqual(['a', 'b', 'c']);
    // The last page: no cursor, so the control hides.
    expect(res.data.nextCursor).toBeNull();
  });

  it('no cursor (or a range) reads nothing', async () => {
    const { client, rpc } = nextPageClient();
    expect(await readNextPlanTabPage(client, ARGS, { ...SHOWN, nextCursor: null })).toBeNull();
    expect(
      await readNextPlanTabPage(
        client,
        { ...ARGS, range: { start: '2026-10-01', end: '2026-10-31' } },
        SHOWN,
      ),
    ).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('a failed page is a failure (the list keeps what it shows)', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: 'boom' } }));
    const res = await readNextPlanTabPage({ rpc } as unknown as Client, ARGS, SHOWN);
    expect(res?.ok).toBe(false);
  });
});

describe('plan-tab-more slot', () => {
  it('holds the control until cleared', () => {
    const onMore = (): void => {};
    setPlanTabMore({ busy: false, onMore });
    expect(getPlanTabMore()?.onMore).toBe(onMore);
    setPlanTabMore(null);
    expect(getPlanTabMore()).toBeNull();
  });
});
