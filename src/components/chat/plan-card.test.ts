import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  canForwardPlan,
  clientApproveConfirm,
  defaultPlanRange,
  draftProblem,
  draftsButtonShown,
  teamPlanBlocked,
  itemKindLabel,
  itemPills,
  planChips,
  planProgress,
  planRangeLabel,
  planSharedLine,
  progressLabel,
  progressPercent,
} from '@/components/chat/plan-card';
import type { PlanBundle, PlanItemRow, PlanReviewRow } from '@/lib/chat/plans';

function item(over: Partial<PlanItemRow>): PlanItemRow {
  return {
    id: 'i',
    plan_id: 'plan',
    kind: 'concept',
    position: 0,
    title: 'Concept',
    description: null,
    post_id: null,
    created_at: '2026-10-09T10:00:00Z',
    ...over,
  };
}

function bundle(
  items: PlanItemRow[],
  reviews: PlanReviewRow[] = [],
  postStages: Record<string, string> = {},
  audience: 'team' | 'client' = 'client',
): PlanBundle {
  return {
    plan: {
      id: 'plan',
      workspace_id: 'ws',
      title: 'Week of 12 Oct',
      starts_on: '2026-10-12',
      ends_on: '2026-10-18',
      audience,
      created_by: null,
    },
    items,
    reviews,
    postStages,
    postInfo: {},
  };
}

const MIXED = bundle(
  [
    item({ id: 'c1' }),
    item({ id: 'c2' }),
    item({ id: 'c3' }),
    item({ id: 'p1', kind: 'post', title: null, post_id: 'post1' }),
    item({ id: 'p2', kind: 'post', title: null, post_id: 'post2' }),
  ],
  [
    { item_id: 'c1', side: 'client', status: 'approved' },
    { item_id: 'c2', side: 'client', status: 'changes' },
    { item_id: 'c3', side: 'team', status: 'approved' },
    // A client review on a post item never counts: the post stage decides.
    { item_id: 'p2', side: 'client', status: 'approved' },
  ],
  { post1: 'approved', post2: 'review' },
);

describe('plan progress', () => {
  it('counts concept client reviews and post stages; team reviews never count', () => {
    expect(planProgress(MIXED)).toEqual({ approved: 2, total: 5, changes: 1 });
    expect(progressLabel(planProgress(MIXED))).toBe('2 of 5 approved by client · 1 change asked');
    expect(progressPercent(planProgress(MIXED))).toBe(40);
  });

  it('no changes: the label stops after the approvals; an empty plan is 0%', () => {
    const empty = bundle([]);
    expect(progressLabel(planProgress(empty))).toBe('0 of 0 approved by client');
    expect(progressPercent(planProgress(empty))).toBe(0);
    const two = bundle(
      [item({ id: 'a' }), item({ id: 'b' })],
      [
        { item_id: 'a', side: 'client', status: 'changes' },
        { item_id: 'b', side: 'client', status: 'changes' },
      ],
    );
    expect(progressLabel(planProgress(two))).toBe('0 of 2 approved by client · 2 changes asked');
  });
});

describe('plan chips and forward', () => {
  it('counts concepts and posts; "Team only" only on a team plan', () => {
    expect(planChips(MIXED).map((c) => c.label)).toEqual(['3 concepts', '2 posts']);
    const team = { ...MIXED, plan: { ...MIXED.plan, audience: 'team' as const } };
    expect(planChips(team)).toEqual([
      { label: '3 concepts', tone: 'neutral' },
      { label: '2 posts', tone: 'neutral' },
      { label: 'Team only', tone: 'warn' },
    ]);
    expect(planChips(bundle([item({ id: 'x' })])).map((c) => c.label)).toEqual([
      '1 concept',
      '0 posts',
    ]);
  });

  it('Forward only for a client viewer on a client plan', () => {
    expect(canForwardPlan('client', 'client')).toBe(true);
    expect(canForwardPlan('client', 'team')).toBe(false);
    expect(canForwardPlan('agency', 'client')).toBe(false);
    expect(canForwardPlan('unknown', 'client')).toBe(false);
  });
});

describe('rows and labels', () => {
  it('agency sees Team and Client pills; a client sees one pill with no side prefix', () => {
    const c1 = MIXED.items[0] as PlanItemRow;
    expect(itemPills(MIXED, c1, 'agency').map((p) => p.label)).toEqual([
      'Team · Waiting',
      'Client · Approved',
    ]);
    expect(itemPills(MIXED, c1, 'client').map((p) => p.label)).toEqual(['Approved']);
    const p1 = MIXED.items[3] as PlanItemRow;
    expect(itemPills(MIXED, p1, 'client').map((p) => p.label)).toEqual(['Approved']);
    const c2 = MIXED.items[1] as PlanItemRow;
    expect(itemPills(MIXED, c2, 'client')[0]).toMatchObject({
      label: 'Changes asked',
      tone: 'review',
    });
  });

  it('kind labels count within their kind', () => {
    expect(itemKindLabel(MIXED.items, MIXED.items[0] as PlanItemRow)).toBe('Concept 1 of 3');
    expect(itemKindLabel(MIXED.items, MIXED.items[4] as PlanItemRow)).toBe('Post 2 of 2');
  });

  it('the range reads "12 Oct - 18 Oct" (no em-dash) and the shared line per side', () => {
    const range = planRangeLabel('2026-10-12', '2026-10-18');
    expect(range).toBe('12 Oct - 18 Oct');
    expect(range).not.toContain(String.fromCharCode(0x2014));
    expect(planSharedLine('agency', 'Manisha Thakur')).toBe('Shared with Manisha Thakur');
    expect(planSharedLine('client', 'Chitra')).toBe('Shared by Chitra');
    expect(clientApproveConfirm('Reel')).toBe(
      'Approve "Reel"? The team will go ahead and make this into a post.',
    );
  });
});

describe('New plan defaults and checks', () => {
  it('defaults to this Monday to Sunday in the workspace zone', () => {
    // Fri 9 Oct 2026, 20:00 UTC is Sat 10 Oct in Kolkata: still the week of 5 Oct.
    expect(defaultPlanRange(new Date('2026-10-09T20:00:00Z'), 'Asia/Kolkata')).toEqual({
      startsOn: '2026-10-05',
      endsOn: '2026-10-11',
    });
    // Sun 11 Oct 2026, 20:00 UTC is Mon 12 Oct in Kolkata: the next week.
    expect(defaultPlanRange(new Date('2026-10-11T20:00:00Z'), 'Asia/Kolkata')).toEqual({
      startsOn: '2026-10-12',
      endsOn: '2026-10-18',
    });
    // The same instant in Los Angeles is still Sunday 11 Oct.
    expect(defaultPlanRange(new Date('2026-10-11T20:00:00Z'), 'America/Los_Angeles')).toEqual({
      startsOn: '2026-10-05',
      endsOn: '2026-10-11',
    });
  });

  it('title 1..200, To on or after From, at most 92 days', () => {
    const base = { title: 'Plan', startsOn: '2026-10-12', endsOn: '2026-10-18' };
    expect(draftProblem(base)).toBeNull();
    expect(draftProblem({ ...base, title: '   ' })).toBe('title');
    expect(draftProblem({ ...base, title: 'x'.repeat(201) })).toBe('title');
    expect(draftProblem({ ...base, endsOn: '2026-10-11' })).toBe('dates');
    expect(draftProblem({ ...base, endsOn: '2027-01-13' })).toBe('too_long');
    expect(draftProblem({ ...base, endsOn: '2027-01-12' })).toBeNull();
  });

  it('"Add drafts" only for a team plan in a chat known to have no client', () => {
    expect(draftsButtonShown('team', false)).toBe(true);
    expect(draftsButtonShown('team', true)).toBe(false);
    expect(draftsButtonShown('team', null)).toBe(false);
    expect(draftsButtonShown('client', false)).toBe(false);
  });
});

describe('team only plan gating (F1)', () => {
  it('blocks a Team only plan unless the chat is known to have no client', () => {
    expect(teamPlanBlocked('team', true)).toBe(true);
    expect(teamPlanBlocked('team', null)).toBe(true);
    expect(teamPlanBlocked('team', false)).toBe(false);
    expect(teamPlanBlocked('client', true)).toBe(false);
    expect(teamPlanBlocked('client', null)).toBe(false);
  });

  it('the screen disables Share, shows the line and never runs the share when blocked', () => {
    const src = readFileSync(
      fileURLToPath(new URL('./PlanComposeScreen.tsx', import.meta.url)),
      'utf8',
    );
    expect(src).toContain('if (busy || problem !== null || teamBlocked) return;');
    expect(src).toContain('disabled={busy || problem !== null || teamBlocked}');
    expect(src).toContain('{TEAM_PLAN_CLIENT_CHAT}');
  });
});
