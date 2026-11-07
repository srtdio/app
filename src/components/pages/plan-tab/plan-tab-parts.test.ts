import { describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import type { PlanBundle } from '@/lib/chat/plans';
import { planCover } from '@/components/pages/plan-tab/PlanTabList';

describe('the plan card picture', () => {
  it("takes the first item's image in item order: a post's cover, else a concept image", () => {
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
    expect(
      planCover(bundle, {
        posts: { 'post-a': 'v1', 'post-c': 'v3' },
        concepts: { b: { kind: 'image', versionId: 'v2' } },
      }),
    ).toBe('v1');
    // No post cover on a: the concept image of b comes first.
    expect(
      planCover(bundle, {
        posts: { 'post-c': 'v3' },
        concepts: { b: { kind: 'image', versionId: 'v2' } },
      }),
    ).toBe('v2');
    // A concept's file tile is no picture.
    expect(planCover(bundle, { posts: {}, concepts: { b: { kind: 'file' } } })).toBeNull();
    expect(planCover(bundle, { posts: {}, concepts: {} })).toBeNull();
  });
});

describe('Plan tab memory (session reads, kept for the session)', () => {
  it('paints a range read this session at any age, per user, workspace, range and side', async () => {
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
    // Past the window it still paints (the tab refreshes quietly behind it).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + READ_FRESH_MS + 1);
    expect(peekPlanTab('u1', args)).toBe(data);
    vi.useRealTimers();
    // Without a session context nothing is shared.
    expect(peekPlanTab(null, args)).toBeUndefined();
    resetSessionReads();
  });
});
