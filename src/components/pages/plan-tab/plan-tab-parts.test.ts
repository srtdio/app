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

describe('Plan tab memory', () => {
  it('keeps the newest ranges, drops the oldest, and forgets on request', async () => {
    const { rememberPlanTab, rememberedPlanTab, forgetPlanTab, PLAN_TAB_MEMORY_MAX } =
      await import('./use-plan-tab-data');
    forgetPlanTab();
    const data = { bundles: [], posts: [], thumbs: { posts: {}, concepts: {} }, anyPlan: false };
    for (let i = 0; i <= PLAN_TAB_MEMORY_MAX; i += 1) rememberPlanTab(`k${i}`, data);
    expect(rememberedPlanTab('k0')).toBeUndefined();
    expect(rememberedPlanTab(`k${PLAN_TAB_MEMORY_MAX}`)).toBe(data);
    forgetPlanTab();
    expect(rememberedPlanTab(`k${PLAN_TAB_MEMORY_MAX}`)).toBeUndefined();
  });
});
