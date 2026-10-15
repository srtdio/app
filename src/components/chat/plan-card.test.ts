import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  canForwardPlan,
  clientApproveConfirm,
  defaultPlanRange,
  draftProblem,
  NO_DATE_LABEL,
  itemDateLabel,
  itemKindLabel,
  itemPills,
  planChips,
  planProgress,
  planRangeLabel,
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
    // A post item's client slot review counts; its post stage never does.
    { item_id: 'p2', side: 'client', status: 'approved' },
  ],
  { post1: 'approved', post2: 'review' },
);

describe('plan progress', () => {
  it('counts client reviews on concepts and post slots; stages and team reviews never count', () => {
    expect(planProgress(MIXED)).toEqual({
      approved: 2,
      teamApproved: 1,
      total: 5,
      changes: 1,
      side: 'client',
    });
    // An Open plan: "Client X of N" for every viewer (no changes part, no team count).
    for (const side of ['agency', 'client', 'unknown'] as const) {
      expect(progressLabel(planProgress(MIXED), side)).toBe('Approved 2 of 5');
    }
    expect(progressPercent(planProgress(MIXED))).toBe(40);
  });

  it('no changes: the label stops after the approvals; an empty plan is 0%', () => {
    const empty = bundle([]);
    expect(progressLabel(planProgress(empty), 'client')).toBe('Approved 0 of 0');
    expect(progressPercent(planProgress(empty))).toBe(0);
    const two = bundle(
      [item({ id: 'a' }), item({ id: 'b' })],
      [
        { item_id: 'a', side: 'client', status: 'changes' },
        { item_id: 'b', side: 'client', status: 'changes' },
      ],
    );
    expect(progressLabel(planProgress(two), 'client')).toBe('Approved 0 of 2');
  });
});

describe('plan chips and forward', () => {
  it('counts concepts and posts; "Draft" only on a Draft (team) plan', () => {
    expect(planChips(MIXED).map((c) => c.label)).toEqual(['3 concepts', '2 posts']);
    const team = { ...MIXED, plan: { ...MIXED.plan, audience: 'team' as const } };
    expect(planChips(team)).toEqual([
      { label: '3 concepts', tone: 'neutral' },
      { label: '2 posts', tone: 'neutral' },
      { label: 'Draft', tone: 'warn' },
    ]);
    expect(planChips(bundle([item({ id: 'x' })])).map((c) => c.label)).toEqual([
      '1 concept',
      '0 posts',
    ]);
  });

  it('Forward: the agency on every plan, a client on a client plan only', () => {
    const matrix = (['agency', 'client', 'unknown'] as const).flatMap((side) =>
      (['client', 'team'] as const).map((audience) => [
        side,
        audience,
        canForwardPlan(side, audience),
      ]),
    );
    expect(matrix).toEqual([
      ['agency', 'client', true],
      ['agency', 'team', true],
      ['client', 'client', true],
      ['client', 'team', false],
      ['unknown', 'client', false],
      ['unknown', 'team', false],
    ]);
  });
});

describe('rows and labels', () => {
  it('agency sees Agency and Client pills on a Draft plan, Client alone on an Open plan', () => {
    const c1 = MIXED.items[0] as PlanItemRow;
    const draft = { ...MIXED, plan: { ...MIXED.plan, audience: 'team' as const } };
    expect(itemPills(draft, c1, 'agency').map((p) => p.label)).toEqual([
      'Creators · Waiting',
      'Approvers · Approved',
    ]);
    // Team reviews are never shown on an Open plan.
    expect(itemPills(MIXED, c1, 'agency').map((p) => p.label)).toEqual(['Approvers · Approved']);
    expect(itemPills(MIXED, c1, 'client').map((p) => p.label)).toEqual(['Approved']);
    // A post's pill follows its client slot review, not its stage.
    const p1 = MIXED.items[3] as PlanItemRow;
    expect(itemPills(MIXED, p1, 'client').map((p) => p.label)).toEqual(['Waiting']);
    const p2 = MIXED.items[4] as PlanItemRow;
    expect(itemPills(MIXED, p2, 'client').map((p) => p.label)).toEqual(['Approved']);
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

  it('the range reads "12 Oct - 18 Oct" (no em-dash)', () => {
    const range = planRangeLabel('2026-10-12', '2026-10-18');
    expect(range).toBe('12 Oct - 18 Oct');
    expect(range).not.toContain(String.fromCharCode(0x2014));
    expect(clientApproveConfirm('Reel')).toBe(
      'Approve "Reel"? The creators will go ahead and make this into a post.',
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
});

describe('Create plan (item 1)', () => {
  const src = readFileSync(
    fileURLToPath(new URL('./PlanComposeScreen.tsx', import.meta.url)),
    'utf8',
  );
  it('has no audience toggle or hints; every new plan is a Draft (team)', () => {
    expect(src).not.toMatch(/data-plan-audience|AUDIENCE_HINTS|Who can see it/);
    expect(src).toContain("export const NEW_PLAN_AUDIENCE = 'team';");
    // plan_create_with_items makes every plan a Draft: no audience is sent.
    expect(src).toContain('planCreateWithItems(supabase, args)');
    expect(src).not.toMatch(/p_audience/);
  });
  it('drafts are always allowed in the picker; the footer reads Create plan', () => {
    expect(src).toContain('data-plan-add-drafts');
    expect(src).not.toMatch(/showDrafts|teamBlocked/);
    expect(src).toContain('channelHasClient={false}');
    expect(src).toContain('CREATE_PLAN_LABEL');
  });
  it('never sends a card to chat: no chat_plan_share, no share step', () => {
    expect(src).not.toMatch(/chatPlanShare|share: /);
    expect(src).toContain('props.onCreated(planId, false)');
  });
});

describe('both progress counts (D1)', () => {
  it('team counts team reviews; client counts client reviews on concepts and post slots', () => {
    const b = bundle(
      [
        item({ id: 'c1' }),
        item({ id: 'c2' }),
        item({ id: 'p1', kind: 'post', title: null, post_id: 'post1' }),
        item({ id: 'p2', kind: 'post', title: null, post_id: 'post2' }),
      ],
      [
        { item_id: 'c1', side: 'team', status: 'approved' },
        { item_id: 'c1', side: 'client', status: 'approved' },
        { item_id: 'c2', side: 'team', status: 'changes' },
        { item_id: 'p1', side: 'team', status: 'approved' },
        { item_id: 'p2', side: 'team', status: 'approved' },
        { item_id: 'p2', side: 'client', status: 'approved' },
      ],
      // post1 at stage approved has no client slot review: not client approved.
      { post1: 'approved', post2: 'review' },
    );
    const p = planProgress(b);
    expect(p).toEqual({ approved: 2, teamApproved: 3, total: 4, changes: 0, side: 'client' });
    // Open: the client side for everyone, never the team count.
    expect(progressLabel(p, 'agency')).toBe('Approved 2 of 4');
    expect(progressPercent(p)).toBe(50);
    // Draft: the team side.
    const draft = planProgress({ ...b, plan: { ...b.plan, audience: 'team' } });
    expect(progressLabel(draft, 'agency')).toBe('Team 3 of 4');
    expect(progressPercent(draft)).toBe(75);
  });

  it('a missing review row reads as waiting on both sides', () => {
    const b = bundle([item({ id: 'a' }), item({ id: 'b' })]);
    expect(planProgress(b)).toMatchObject({ approved: 0, teamApproved: 0, total: 2, changes: 0 });
    expect(progressLabel(planProgress(b), 'agency')).toBe('Approved 0 of 2');
  });

  it('an unreadable post counts in N and is never client approved', () => {
    const b = bundle(
      [item({ id: 'c' }), item({ id: 'p', kind: 'post', title: null, post_id: 'hidden' })],
      [{ item_id: 'c', side: 'client', status: 'approved' }],
      {},
    );
    expect(planProgress(b)).toMatchObject({ approved: 1, total: 2 });
  });

  it('the old two-count strings are gone', () => {
    const src = readFileSync(fileURLToPath(new URL('./plan-card.ts', import.meta.url)), 'utf8');
    expect(src).not.toContain('approved`');
    expect(src).not.toMatch(/Agency \$\{/);
  });

  it('nobody sees a team count on an Open plan', () => {
    for (const side of ['agency', 'client', 'unknown'] as const) {
      const label = progressLabel(planProgress(MIXED), side);
      expect(label).toBe('Approved 2 of 5');
      expect(label).not.toMatch(/Agency|Team/);
    }
  });

  it('one helper counts (no per-row reviews.find in plan-card.ts)', () => {
    const src = readFileSync(fileURLToPath(new URL('./plan-card.ts', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/reviews\.find\(/);
  });
});

describe('date labels (D3, item 8)', () => {
  const posts = bundle([
    item({ id: 'cd', target_date: '2026-10-14' }),
    item({ id: 'cu' }),
    // A stale plan_items.target_date on a post slot never places it.
    item({ id: 'pd', kind: 'post', title: null, post_id: 'post1', target_date: '2026-10-11' }),
    item({ id: 'pu', kind: 'post', title: null, post_id: 'post2' }),
  ]);
  posts.postInfo = {
    // 12:00 Asia/Kolkata on 15 Oct.
    post1: { title: 'A', target_date: '2026-10-15T06:30:00+00:00' },
    post2: { title: 'B', target_date: null },
  };
  const at = (id: string): PlanItemRow => posts.items.find((i) => i.id === id) as PlanItemRow;

  it('a dated concept shows its day', () => {
    expect(itemDateLabel(posts, at('cd'))).toEqual({ label: '14 Oct', dated: true });
  });
  it('an undated concept shows "No date"', () => {
    expect(itemDateLabel(posts, at('cu'))).toEqual({ label: NO_DATE_LABEL, dated: false });
    expect(NO_DATE_LABEL).toBe('No date');
  });
  it('a post slot shows its post\'s target_date in the zone; without one "No date"', () => {
    expect(itemDateLabel(posts, at('pd'), 'Asia/Kolkata')).toEqual({
      label: '15 Oct',
      dated: true,
    });
    expect(itemDateLabel(posts, at('pu'), 'Asia/Kolkata')).toEqual({
      label: NO_DATE_LABEL,
      dated: false,
    });
  });
});
