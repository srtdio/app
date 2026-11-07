import { describe, expect, it } from 'vitest';
import type { PlanBundle, PlanItemRow, PlanRow } from '@/lib/chat/plans';
import {
  calendarEntries,
  canCreatePlans,
  monthLabel,
  onboardingFinished,
  planCardMeta,
  planCardPreview,
  planSectionOf,
  planSections,
  parsePlanWeekChip,
  plansInToneOrder,
  visiblePlanChips,
  planWeekChipLabel,
  planChipHolds,
  PLAN_WEEK_CHIPS,
  PLAN_WEEK_CHIP_DEFAULT,
  postStageLine,
  visibleBundles,
  weekRangeOf,
  zeroStateCopy,
  type LoosePost,
} from '@/lib/plan-tab';
import { civilDayOf } from '@/lib/plan-week';

function plan(
  id: string,
  startsOn: string,
  endsOn: string,
  audience: 'team' | 'client' = 'client',
): PlanRow {
  return {
    id,
    workspace_id: 'ws',
    title: `Plan ${id}`,
    starts_on: startsOn,
    ends_on: endsOn,
    audience,
    created_by: null,
  };
}

function item(over: Partial<PlanItemRow> & { id: string }): PlanItemRow {
  return {
    plan_id: 'p',
    kind: 'concept',
    position: 0,
    title: over.id,
    description: null,
    post_id: null,
    created_at: '2026-10-01T00:00:00Z',
    ...over,
  };
}

function bundle(
  row: PlanRow,
  items: PlanItemRow[] = [],
  over: Partial<PlanBundle> = {},
): PlanBundle {
  return { plan: row, items, reviews: [], postStages: {}, postInfo: {}, ...over };
}

describe('weeks and labels', () => {
  it('orders plans by start date, ties by id', () => {
    const order = plansInToneOrder([
      plan('e', '2026-10-20', '2026-10-25'),
      plan('b', '2026-10-01', '2026-10-07'),
      plan('a', '2026-10-01', '2026-10-07'),
    ]);
    expect(order.map((p) => p.id)).toEqual(['a', 'b', 'e']);
  });

  it('labels the month and reads the Mon to Sun week', () => {
    expect(monthLabel('2026-10-22')).toBe('October 2026');
    expect(weekRangeOf('2026-10-22')).toEqual({ startsOn: '2026-10-19', endsOn: '2026-10-25' });
    expect(weekRangeOf('2026-10-25')).toEqual({ startsOn: '2026-10-19', endsOn: '2026-10-25' });
  });
});

describe('calendar entries', () => {
  const a = bundle(
    plan('a', '2026-10-19', '2026-10-25'),
    [
      item({ id: 'a1', plan_id: 'a', target_date: '2026-10-20' }),
      item({ id: 'a2', plan_id: 'a', target_date: null }),
      item({ id: 'a3', plan_id: 'a', kind: 'post', post_id: 'p1' }),
    ],
    { postInfo: { p1: { title: 'Post one', target_date: '2026-10-22T12:00:00Z' } } },
  );
  const b = bundle(plan('b', '2026-10-12', '2026-10-25'), [
    item({ id: 'b1', plan_id: 'b', target_date: '2026-10-20' }),
  ]);
  const loose: LoosePost[] = [
    { id: 'x', title: 'Loose', stage: 'review', target_date: '2026-10-21T12:00:00Z' },
  ];
  const run = (filter: string | null, overrides?: Record<string, string>) =>
    calendarEntries({
      bundles: [a, b],
      posts: loose,
      tones: new Map([
        [b.plan.id, 'accent' as const],
        [a.plan.id, 'good' as const],
      ]),
      timeZone: 'UTC',
      filter,
      titleOf: (_b, i) => i.title ?? '',
      dayOfPost: (p) => civilDayOf(p.target_date, 'UTC'),
      ...(overrides !== undefined ? { overrides } : {}),
    });

  it('All: every dated plan item (plans in colour order) and loose posts', () => {
    const days = run(null);
    expect(days.get('2026-10-20')?.map((e) => e.key)).toEqual(['item:b1', 'item:a1']);
    expect(days.get('2026-10-22')?.map((e) => e.key)).toEqual(['item:a3']);
    expect(days.get('2026-10-21')?.map((e) => e.key)).toEqual(['post:x']);
    const tones = days.get('2026-10-20')?.map((e) => (e.kind === 'item' ? e.tone : null));
    expect(tones).toEqual(['accent', 'good']);
  });

  it('a plan chip: only that plan, no loose posts', () => {
    const days = run('a');
    expect(
      [...days.values()]
        .flat()
        .map((e) => e.key)
        .sort(),
    ).toEqual(['item:a1', 'item:a3']);
  });

  it('an override moves an entry to its new day', () => {
    const days = run(null, { 'post:x': '2026-10-24' });
    expect(days.get('2026-10-21')).toBeUndefined();
    expect(days.get('2026-10-24')?.map((e) => e.key)).toEqual(['post:x']);
  });
});

describe('who sees what', () => {
  const draft = bundle(plan('d', '2026-10-19', '2026-10-25', 'team'));
  const shared = bundle(plan('s', '2026-10-19', '2026-10-25', 'client'));

  it('approvers never see drafts or Create', () => {
    for (const side of ['client', 'unknown'] as const) {
      expect(visibleBundles([draft, shared], side).map((b) => b.plan.id)).toEqual(['s']);
      expect(canCreatePlans(side)).toBe(false);
    }
  });

  it('creators see every plan and get Create', () => {
    expect(visibleBundles([draft, shared], 'agency')).toHaveLength(2);
    expect(canCreatePlans('agency')).toBe(true);
  });
});

describe('the post line', () => {
  const p = plan('p', '2026-10-19', '2026-10-25');
  const c = item({ id: 'c', plan_id: 'p' });
  const post = item({ id: 'po', plan_id: 'p', kind: 'post', post_id: 'p9' });

  it('shows the post stage as stored, or No post yet', () => {
    const b = bundle(p, [c, post], { postStages: { p9: 'review' } });
    expect(postStageLine(b, post)).toBe('Post: Review');
    expect(postStageLine(b, c)).toBe('No post yet');
    expect(postStageLine(b, item({ id: 'dr', kind: 'post', draft_row: true }))).toBe('Post: Draft');
  });
});

describe('the list (phone and laptop)', () => {
  const today = '2026-10-22';

  it('buckets by this week, next week, later and earlier', () => {
    expect(planSectionOf({ starts_on: '2026-10-10', ends_on: '2026-10-19' }, today)).toBe('this');
    expect(planSectionOf({ starts_on: '2026-10-25', ends_on: '2026-11-08' }, today)).toBe('this');
    expect(planSectionOf({ starts_on: '2026-10-26', ends_on: '2026-10-30' }, today)).toBe('next');
    expect(planSectionOf({ starts_on: '2026-11-02', ends_on: '2026-11-08' }, today)).toBe('later');
    expect(planSectionOf({ starts_on: '2026-10-01', ends_on: '2026-10-18' }, today)).toBe(
      'earlier',
    );
  });

  it('orders sections and plans, hiding empty sections', () => {
    const sections = planSections(
      [
        bundle(plan('old1', '2026-09-01', '2026-09-07')),
        bundle(plan('later', '2026-11-09', '2026-11-15')),
        bundle(plan('old2', '2026-10-05', '2026-10-11')),
        bundle(plan('this2', '2026-10-20', '2026-10-24')),
        bundle(plan('this1', '2026-10-19', '2026-10-25')),
      ],
      today,
    );
    expect(sections.map((s) => [s.label, s.bundles.map((b) => b.plan.id)])).toEqual([
      ['This week', ['this1', 'this2']],
      ['Later', ['later']],
      ['Past', ['old2', 'old1']],
    ]);
  });

  it('a shared card tags its OKs; a draft is tagged Draft and says only the team sees it', () => {
    const shared = bundle(plan('s', today, today), [item({ id: 'i1' }), item({ id: 'i2' })], {
      reviews: [{ item_id: 'i1', side: 'client', status: 'approved' }],
    });
    expect(planCardMeta(shared)).toEqual({
      kind: 'shared',
      tag: '1 of 2 OK',
      count: '2 posts',
      ok: 1,
      total: 2,
      percent: 50,
    });
    const draft = bundle(plan('d', today, today, 'team'), [item({ id: 'i3' }), item({ id: 'i4' })]);
    expect(planCardMeta(draft)).toEqual({
      kind: 'draft',
      tag: 'Draft',
      count: '2 posts · only your team sees this',
      total: 2,
    });
  });

  it('one item says "1 post"', () => {
    const draft = bundle(plan('d1', today, today, 'team'), [item({ id: 'i5' })]);
    expect(planCardMeta(draft).count).toBe('1 post · only your team sees this');
  });

  it('line 2 is the date range then the count, on one line that wraps', () => {
    const now = new Date('2026-10-22T12:00:00Z');
    const shared = bundle(plan('s', '2026-10-19', '2026-10-25'), [item({ id: 'i1' })]);
    expect(planCardPreview(shared, 'UTC', now)).toBe('19\u201325 Oct · 1 post');
    const draft = bundle(plan('d', '2026-10-26', '2026-11-01', 'team'), []);
    expect(planCardPreview(draft, 'UTC', now)).toBe(
      '26 Oct \u2013 1 Nov · 0 posts · only your team sees this',
    );
  });
});

describe('zero state', () => {
  it('shows line 2 only until onboarding is finished', () => {
    expect(zeroStateCopy('agency', false)).toEqual({
      title: 'No plans yet',
      line2: 'Plan the content together, week by week',
      create: true,
    });
    expect(zeroStateCopy('agency', true).line2).toBeNull();
    expect(zeroStateCopy('client', false)).toEqual({
      title: 'No plans shared yet',
      line2: "Plans show up here once they're shared with you",
      create: false,
    });
    expect(zeroStateCopy('client', true)).toEqual({
      title: 'No plans shared yet',
      line2: null,
      create: false,
    });
  });

  it('reads onboarding as finished once the guide is off', () => {
    expect(onboardingFinished('off')).toBe(true);
    expect(onboardingFinished(null)).toBe(true);
    expect(onboardingFinished('step')).toBe(false);
    expect(onboardingFinished('intro')).toBe(false);
    expect(onboardingFinished('closing')).toBe(false);
  });
});

describe('Plan chips (decision D)', () => {
  it('reads Bank, Upcoming, Past in that order, Upcoming by default', () => {
    expect([...PLAN_WEEK_CHIPS]).toEqual(['bank', 'upcoming', 'past']);
    expect(PLAN_WEEK_CHIPS.map(planWeekChipLabel)).toEqual(['Bank', 'Upcoming', 'Past']);
    expect(PLAN_WEEK_CHIP_DEFAULT).toBe('upcoming');
  });

  it('parses its own chips and maps the retired ones: this, next, later, all to Upcoming; earlier to Past', () => {
    expect(parsePlanWeekChip('bank')).toBe('bank');
    expect(parsePlanWeekChip('upcoming')).toBe('upcoming');
    expect(parsePlanWeekChip('past')).toBe('past');
    for (const old of ['this', 'next', 'later', 'all']) {
      expect(parsePlanWeekChip(old)).toBe('upcoming');
    }
    expect(parsePlanWeekChip('earlier')).toBe('past');
    expect(parsePlanWeekChip('soon')).toBeNull();
    expect(parsePlanWeekChip('')).toBeNull();
    expect(parsePlanWeekChip(null)).toBeNull();
  });

  it('hides Bank unless the viewer may see it; the order stays', () => {
    expect(visiblePlanChips(false)).toEqual(['upcoming', 'past']);
    expect(visiblePlanChips(true)).toEqual(['bank', 'upcoming', 'past']);
  });

  it('Upcoming holds This week, Next week and Later; Past holds the rest; Bank holds no plan', () => {
    expect(planChipHolds('upcoming', 'this')).toBe(true);
    expect(planChipHolds('upcoming', 'next')).toBe(true);
    expect(planChipHolds('upcoming', 'later')).toBe(true);
    expect(planChipHolds('upcoming', 'earlier')).toBe(false);
    expect(planChipHolds('past', 'earlier')).toBe(true);
    expect(planChipHolds('past', 'this')).toBe(false);
    expect(planChipHolds('bank', 'this')).toBe(false);
  });
});
