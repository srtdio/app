import { describe, expect, it } from 'vitest';
import type { PlanBundle, PlanItemRow, PlanRow } from '@/lib/chat/plans';
import {
  PLAN_TONE_CLASSES,
  addOnLabel,
  calendarEntries,
  canCreatePlans,
  canDragEntries,
  canDropOn,
  canOpenDayMenu,
  capEntries,
  monthGrid,
  monthLabel,
  moreLabel,
  onboardingFinished,
  planCardMeta,
  planPill,
  planSectionOf,
  planSections,
  planTones,
  plansCovering,
  postStageLine,
  rangeLabel,
  shiftAnchor,
  visibleBundles,
  visibleRange,
  weekDays,
  weekRangeLabel,
  weekRangeOf,
  zeroStateCopy,
  type CalendarEntry,
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

describe('plan colours', () => {
  it('cycles accent, good, warn, parked by start date (ties by id), then repeats', () => {
    const tones = planTones([
      plan('e', '2026-10-20', '2026-10-25'),
      plan('b', '2026-10-01', '2026-10-07'),
      plan('a', '2026-10-01', '2026-10-07'),
      plan('d', '2026-10-15', '2026-10-21'),
      plan('c', '2026-10-08', '2026-10-14'),
    ]);
    expect([...'abcde'].map((id) => tones.get(id))).toEqual([
      'accent',
      'good',
      'warn',
      'parked',
      'accent',
    ]);
  });

  it('uses the soft tokens, and color-mix for parked (no new hex)', () => {
    expect(PLAN_TONE_CLASSES.accent).toEqual({ soft: 'bg-accent-soft', dot: 'bg-accent' });
    expect(PLAN_TONE_CLASSES.good.soft).toBe('bg-good-soft');
    expect(PLAN_TONE_CLASSES.warn.soft).toBe('bg-warn-soft');
    expect(PLAN_TONE_CLASSES.parked.soft).toBe(
      'bg-[color-mix(in_srgb,var(--stage-parked)_14%,transparent)]',
    );
    expect(JSON.stringify(PLAN_TONE_CLASSES)).not.toMatch(/#[0-9a-f]{3,6}/i);
  });
});

describe('month grid', () => {
  it('runs Monday first in whole weeks, out-of-month days marked', () => {
    const weeks = monthGrid('2026-10-22');
    expect(weeks).toHaveLength(5);
    expect(weeks[0]?.[0]).toEqual({ day: '2026-09-28', inMonth: false });
    expect(weeks[0]?.[3]).toEqual({ day: '2026-10-01', inMonth: true });
    expect(weeks[4]?.[6]).toEqual({ day: '2026-11-01', inMonth: false });
    for (const week of weeks) expect(week).toHaveLength(7);
    expect(weeks.flat().filter((c) => c.inMonth)).toHaveLength(31);
  });

  it('a month starting on a Monday starts on its 1st', () => {
    expect(monthGrid('2026-06-10')[0]?.[0]).toEqual({ day: '2026-06-01', inMonth: true });
  });

  it('shows three entries a cell, then "+N more"', () => {
    expect(capEntries(['a', 'b'])).toEqual({ shown: ['a', 'b'], more: 0 });
    expect(capEntries(['a', 'b', 'c', 'd', 'e'])).toEqual({ shown: ['a', 'b', 'c'], more: 2 });
    expect(moreLabel(2)).toBe('+2 more');
  });

  it('reads the whole weeks as the visible range', () => {
    expect(visibleRange('month', '2026-10-22')).toEqual({ start: '2026-09-28', end: '2026-11-01' });
    expect(visibleRange('week', '2026-10-22')).toEqual({ start: '2026-10-19', end: '2026-10-25' });
  });
});

describe('labels and steps', () => {
  it('labels the month and the week with a spaced hyphen', () => {
    expect(monthLabel('2026-10-22')).toBe('October 2026');
    expect(weekRangeLabel('2026-10-22')).toBe('19 - 25 Oct 2026');
    expect(weekRangeLabel('2026-10-01')).toBe('28 Sep - 4 Oct 2026');
    expect(weekRangeLabel('2026-12-31')).toBe('28 Dec 2026 - 3 Jan 2027');
    expect(rangeLabel('month', '2026-10-01')).toBe('October 2026');
    for (const label of [weekRangeLabel('2026-10-01'), weekRangeLabel('2026-12-31')]) {
      expect(label).not.toMatch(/[–—]/);
    }
  });

  it('steps a month to its 1st and a week by seven days', () => {
    expect(shiftAnchor('month', '2026-10-22', 1)).toBe('2026-11-01');
    expect(shiftAnchor('month', '2026-01-15', -1)).toBe('2025-12-01');
    expect(shiftAnchor('week', '2026-10-22', 1)).toBe('2026-10-26');
    expect(shiftAnchor('week', '2026-10-22', -1)).toBe('2026-10-12');
    expect(weekDays('2026-10-22')).toEqual([
      '2026-10-19',
      '2026-10-20',
      '2026-10-21',
      '2026-10-22',
      '2026-10-23',
      '2026-10-24',
      '2026-10-25',
    ]);
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
      tones: planTones([a.plan, b.plan]),
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

  it('drops a plan item only inside its plan, a loose post on any other day', () => {
    const days = run(null);
    const a1 = days.get('2026-10-20')?.find((e) => e.key === 'item:a1') as CalendarEntry;
    const x = days.get('2026-10-21')?.[0] as CalendarEntry;
    expect(canDropOn(a1, '2026-10-21')).toBe(true);
    expect(canDropOn(a1, '2026-10-20')).toBe(false);
    expect(canDropOn(a1, '2026-10-26')).toBe(false);
    expect(canDropOn(x, '2026-11-02')).toBe(true);
  });
});

describe('the empty-day menu', () => {
  it('lists only the plans whose dates hold the day', () => {
    const bundles = [
      bundle(plan('late', '2026-10-22', '2026-10-30')),
      bundle(plan('before', '2026-10-01', '2026-10-21')),
      bundle(plan('early', '2026-10-15', '2026-10-22')),
    ];
    expect(plansCovering(bundles, '2026-10-22').map((b) => b.plan.id)).toEqual(['early', 'late']);
    expect(plansCovering(bundles, '2026-10-31')).toEqual([]);
    expect(addOnLabel('2026-10-22')).toBe('Add on Thu 22 Oct to');
  });
});

describe('who sees what', () => {
  const draft = bundle(plan('d', '2026-10-19', '2026-10-25', 'team'));
  const shared = bundle(plan('s', '2026-10-19', '2026-10-25', 'client'));

  it('approvers never see drafts, Create, drag or the day menu', () => {
    for (const side of ['client', 'unknown'] as const) {
      expect(visibleBundles([draft, shared], side).map((b) => b.plan.id)).toEqual(['s']);
      expect(canCreatePlans(side)).toBe(false);
      expect(canDragEntries(side)).toBe(false);
      expect(canOpenDayMenu(side)).toBe(false);
    }
  });

  it('creators see every plan and get Create, drag and the day menu', () => {
    expect(visibleBundles([draft, shared], 'agency')).toHaveLength(2);
    expect(canCreatePlans('agency')).toBe(true);
    expect(canDragEntries('agency')).toBe(true);
    expect(canOpenDayMenu('agency')).toBe(true);
  });
});

describe('the week card', () => {
  const p = plan('p', '2026-10-19', '2026-10-25');
  const c = item({ id: 'c', plan_id: 'p' });
  const post = item({ id: 'po', plan_id: 'p', kind: 'post', post_id: 'p9' });

  it('reads the shown side: OK, Not OK, else not decided', () => {
    const b = bundle(p, [c, post], {
      reviews: [
        { item_id: 'c', side: 'client', status: 'approved' },
        { item_id: 'po', side: 'client', status: 'changes' },
      ],
    });
    expect(planPill(b, c)).toEqual({ label: 'Plan OK', tone: 'good' });
    expect(planPill(b, post)).toEqual({ label: 'Plan Not OK', tone: 'bad' });
    expect(planPill(bundle(p, [c]), c)).toEqual({ label: 'Plan: not decided', tone: 'neutral' });
  });

  it('shows the post stage as stored, or No post yet', () => {
    const b = bundle(p, [c, post], { postStages: { p9: 'review' } });
    expect(postStageLine(b, post)).toBe('Post: review');
    expect(postStageLine(b, c)).toBe('No post yet');
    expect(postStageLine(b, item({ id: 'dr', kind: 'post', draft_row: true }))).toBe('Post: draft');
  });
});

describe('the phone list', () => {
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
      ['Earlier', ['old2', 'old1']],
    ]);
  });

  it('a shared card counts OKs; a draft says only the team sees it', () => {
    const shared = bundle(plan('s', today, today), [item({ id: 'i1' }), item({ id: 'i2' })], {
      reviews: [{ item_id: 'i1', side: 'client', status: 'approved' }],
    });
    expect(planCardMeta(shared)).toEqual({
      kind: 'shared',
      label: '1 of 2 OK',
      ok: 1,
      total: 2,
      percent: 50,
    });
    const draft = bundle(plan('d', today, today, 'team'), [item({ id: 'i3' }), item({ id: 'i4' })]);
    expect(planCardMeta(draft)).toEqual({
      kind: 'draft',
      label: '2 items · only your team sees this',
    });
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
