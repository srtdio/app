import { describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import type { PlanBundle } from '@/lib/chat/plans';
import { menuPosition } from '@/components/pages/plan-tab/PlanDayMenu';
import { CARD_COVERS, planCovers } from '@/components/pages/plan-tab/PlanTabList';

describe('the day menu position', () => {
  const view = { width: 1280, height: 800 };
  const menu = { width: 300, height: 200 };

  it('sits at the cell, under its date', () => {
    expect(menuPosition({ left: 400, top: 200, bottom: 328 }, menu, view)).toEqual({
      left: 404,
      top: 228,
    });
  });

  it('stays on screen near the right and bottom edges', () => {
    const pos = menuPosition({ left: 1200, top: 700, bottom: 790 }, menu, view);
    expect(pos.left + menu.width).toBeLessThanOrEqual(view.width - 8);
    expect(pos.top + menu.height).toBeLessThanOrEqual(view.height - 8);
    expect(pos.top).toBeGreaterThanOrEqual(8);
  });
});

describe('the phone card covers', () => {
  it('takes post covers and concept images in item order, at most four, no repeats', () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, position) => ({
      id,
      plan_id: 'p',
      kind: id === 'b' ? ('concept' as const) : ('post' as const),
      position,
      title: null,
      description: null,
      post_id: id === 'b' ? null : `post-${id}`,
      created_at: '',
    }));
    const bundle: PlanBundle = {
      plan: {
        id: 'p',
        workspace_id: 'ws',
        title: 'P',
        starts_on: '2026-10-19',
        ends_on: '2026-10-25',
        audience: 'client',
        created_by: null,
      },
      items,
      reviews: [],
      postStages: {},
      postInfo: {},
    };
    const covers = planCovers(bundle, {
      posts: { 'post-a': 'v1', 'post-c': 'v1', 'post-d': 'v3', 'post-e': 'v4', 'post-f': 'v5' },
      concepts: { b: { kind: 'image', versionId: 'v2' } },
    });
    expect(covers).toEqual(['v1', 'v2', 'v3', 'v4']);
    expect(covers).toHaveLength(CARD_COVERS);
  });
});

describe('Plan tab memory (session reads, freshness window)', () => {
  it('paints a range read inside the window, never one past it', async () => {
    const { peekPlanTab, planTabReadKey } = await import('@/lib/plan-tab-shared');
    const { primeRead, resetSessionReads, READ_FRESH_MS } = await import('@/lib/session-read');
    resetSessionReads();
    const data = {
      bundles: [],
      posts: [],
      thumbs: { posts: {}, concepts: {} },
      anyPlan: false,
      timeZone: 'UTC',
      nextCursor: null,
    };
    const args = { workspaceId: 'w1', range: null, onlyShared: false };
    primeRead(planTabReadKey('u1', args), { ok: true, data });
    expect(peekPlanTab('u1', args)).toBe(data);
    // Another user, workspace, range or side is another key (the zone comes
    // with the read, so it is never part of the key).
    expect(peekPlanTab('u2', args)).toBeUndefined();
    expect(peekPlanTab('u1', { ...args, onlyShared: true })).toBeUndefined();
    expect(peekPlanTab('u1', { ...args, workspaceId: 'w2' })).toBeUndefined();
    expect(
      peekPlanTab('u1', { ...args, range: { start: '2026-10-01', end: '2026-10-31' } }),
    ).toBeUndefined();
    // Past the window it is absent: the tab shows loading and reads again.
    expect(peekPlanTab('u1', args, Date.now() + READ_FRESH_MS + 1)).toBeUndefined();
    // Without a session context nothing is shared.
    expect(peekPlanTab(null, args)).toBeUndefined();
    resetSessionReads();
  });
});
