import { describe, expect, it } from 'vitest';
import { planProgress, todayInZone } from '@/components/chat/plan-card';
import type { ChatMark, MarkCounts } from '@/lib/chat/marks';
import type { PlanBundle, PlanItemRow } from '@/lib/chat/plans';
import {
  NOTHING_OPEN_LINE,
  SECTION_ROWS,
  STATUS_ORDER,
  BAR_PLANS,
  TITLE_ELLIPSIS,
  anyReadFailed,
  capCount,
  currentPlanWindow,
  currentSharedPlans,
  drawerDay,
  drawerKeys,
  drawerShouldClose,
  keptTitle,
  openMarksOfType,
  openPlans,
  planSectionCount,
  planSegment,
  planSummaries,
  planTone,
  postsWord,
  sectionLabel,
  sectionRows,
  statusBar,
  statusItems,
  statusReady,
  titleWords,
  titleWordsKept,
  type PlanSummary,
  type StatusInput,
  type StatusKey,
} from '@/lib/chat/status-bar';

const NO_MARKS: MarkCounts = { commitments: 0, decisions: 0, pending: 0, p1: 0 };

function input(over: Partial<StatusInput> = {}): StatusInput {
  return { plans: [], posts: 0, briefs: 0, marks: NO_MARKS, side: 'agency', ...over };
}

function bundle(
  id: string,
  endsOn: string,
  items: Array<{ client?: 'approved' | 'changes'; team?: 'approved' }> = [],
  startsOn = '2026-10-01',
  audience: 'client' | 'team' = 'client',
): PlanBundle {
  const rows: PlanItemRow[] = items.map((_, i) => ({
    id: `${id}-i${i}`,
    plan_id: id,
    kind: 'concept',
    position: i,
    title: `Item ${i}`,
    description: null,
    post_id: null,
    created_at: '2026-10-01T00:00:00Z',
    target_date: null,
  }));
  return {
    plan: {
      id,
      workspace_id: 'w',
      title: `Plan ${id}`,
      starts_on: startsOn,
      ends_on: endsOn,
      audience,
      created_by: null,
    },
    items: rows,
    reviews: items.flatMap((item, i) => [
      ...(item.client !== undefined
        ? [{ item_id: `${id}-i${i}`, side: 'client' as const, status: item.client }]
        : []),
      ...(item.team !== undefined
        ? [{ item_id: `${id}-i${i}`, side: 'team' as const, status: item.team }]
        : []),
    ]),
    postStages: {},
    postInfo: {},
  };
}

function summary(id: string, approved: number, total: number, changes = 0): PlanSummary {
  return { id, title: `Plan ${id}`, approved, total, changes };
}

describe('statusItems: every on/off combination of the six items', () => {
  it('all 64 combos: fixed order, zero items omitted, the rest close up', () => {
    for (let mask = 0; mask < 64; mask += 1) {
      const on = (bit: number): boolean => (mask & (1 << bit)) !== 0;
      const items = statusItems(
        input({
          plans: on(0) ? [summary('p', 1, 3)] : [],
          posts: on(1) ? 2 : 0,
          briefs: on(2) ? 3 : 0,
          marks: {
            commitments: on(3) ? 4 : 0,
            decisions: on(4) ? 5 : 0,
            pending: on(5) ? 6 : 0,
            p1: 0,
          },
        }),
      );
      const expected = STATUS_ORDER.filter((_, bit) => on(bit));
      expect(items.map((i) => i.key)).toEqual(expected);
      const bar = statusBar(
        input({
          plans: on(0) ? [summary('p', 1, 3)] : [],
          posts: on(1) ? 2 : 0,
          briefs: on(2) ? 3 : 0,
          marks: {
            commitments: on(3) ? 4 : 0,
            decisions: on(4) ? 5 : 0,
            pending: on(5) ? 6 : 0,
            p1: 0,
          },
        }),
      );
      expect(bar.kind).toBe(mask === 0 ? 'empty' : 'items');
    }
  });

  it('the order is plan, posts, briefs, commitments, decisions, pending', () => {
    expect(STATUS_ORDER).toEqual([
      'plan',
      'posts',
      'briefs',
      'commitments',
      'decisions',
      'pending',
    ]);
  });
});

describe('bar wording', () => {
  it('counts over 99 read 99+ (the real count is kept)', () => {
    expect(capCount(99)).toBe('99');
    expect(capCount(100)).toBe('99+');
    const [posts] = statusItems(input({ posts: 120 }));
    expect(posts?.number).toBe('99+');
    expect(posts?.count).toBe(120);
    const [plan] = statusItems(input({ plans: [summary('p', 100, 140)] }));
    expect(plan?.number).toBe('99+/99+');
  });

  it('plural words', () => {
    const word = (over: Partial<StatusInput>): string[] =>
      statusItems(input(over)).map((i) => i.word ?? '');
    expect(word({ briefs: 1 })).toEqual(['brief']);
    expect(word({ briefs: 2 })).toEqual(['briefs']);
    expect(word({ marks: { ...NO_MARKS, commitments: 1 } })).toEqual(['commitment']);
    expect(word({ marks: { ...NO_MARKS, commitments: 3 } })).toEqual(['commitments']);
    expect(word({ marks: { ...NO_MARKS, decisions: 1 } })).toEqual(['decision']);
    expect(word({ marks: { ...NO_MARKS, decisions: 2 } })).toEqual(['decisions']);
    expect(word({ marks: { ...NO_MARKS, pending: 1 } })).toEqual(['pending']);
    expect(word({ marks: { ...NO_MARKS, pending: 7 } })).toEqual(['pending']);
  });

  it('posts wording follows the side', () => {
    expect(postsWord('agency')).toBe('in review');
    expect(postsWord('client')).toBe('waiting');
    expect(postsWord('unknown')).toBe('in review');
    expect(statusItems(input({ posts: 2, side: 'client' }))[0]?.word).toBe('waiting');
  });

  it('one plan reads as today: "Plan", A/N, no +K, never trimmed', () => {
    const items = statusItems(input({ plans: [summary('p', 2, 5)] }));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      key: 'plan',
      id: 'plan:p',
      lead: 'Plan',
      trim: false,
      number: '2/5',
      word: null,
      more: 0,
      tone: 'default',
      aria: 'Plan 2 of 5 approved',
    });
  });

  it('two plans: one item each, the title leads, in the given order, no +K', () => {
    const items = statusItems(
      input({ plans: [summary('a', 1, 3, 1), summary('b', 2, 2)], posts: 4 }),
    );
    expect(items.map((i) => i.id)).toEqual(['plan:a', 'plan:b', 'posts']);
    expect(items[0]).toMatchObject({
      lead: 'Plan a',
      trim: true,
      number: '1/3',
      tone: 'warn',
      more: 0,
      aria: 'Plan a 1 of 3 approved',
    });
    expect(items[1]).toMatchObject({ lead: 'Plan b', number: '2/2', tone: 'good', more: 0 });
  });

  it('three plans: the first two show, the second carries +1', () => {
    const plans = [summary('a', 0, 1), summary('b', 0, 2), summary('c', 0, 3)];
    const items = statusItems(input({ plans }));
    expect(BAR_PLANS).toBe(2);
    expect(items.map((i) => [i.id, i.more])).toEqual([
      ['plan:a', 0],
      ['plan:b', 1],
    ]);
    const five = statusItems(input({ plans: [...plans, summary('d', 0, 1), summary('e', 0, 1)] }));
    expect(five.map((i) => i.more)).toEqual([0, 3]);
  });

  it('no plan: no plan item', () => {
    expect(statusItems(input({ plans: [], briefs: 1 })).map((i) => i.key)).toEqual(['briefs']);
  });

  it('plan colour: changes warn, complete good, else normal', () => {
    expect(planTone({ approved: 2, total: 5, changes: 1 })).toBe('warn');
    expect(planTone({ approved: 5, total: 5, changes: 0 })).toBe('good');
    expect(planTone({ approved: 5, total: 5, changes: 1 })).toBe('warn');
    expect(planTone({ approved: 2, total: 5, changes: 0 })).toBe('default');
    expect(planTone({ approved: 0, total: 0, changes: 0 })).toBe('default');
  });

  it('pending is warn when any open pending is P1', () => {
    const tone = (p1: number): string | undefined =>
      statusItems(input({ marks: { ...NO_MARKS, pending: 2, p1 } }))[0]?.tone;
    expect(tone(1)).toBe('warn');
    expect(tone(0)).toBe('default');
  });
});

describe('empty and failed reads', () => {
  it('empty only when every read succeeded with zero', () => {
    expect(statusBar(input())).toEqual({ kind: 'empty' });
    expect(NOTHING_OPEN_LINE).toBe('Open posts and marks show up here.');
  });

  it('a failed read never yields empty, and omits only its own item', () => {
    for (const failed of ['plans', 'posts', 'briefs', 'marks'] as const) {
      const bar = statusBar(input({ [failed]: null }));
      expect(bar.kind).toBe('blank');
      expect(anyReadFailed(input({ [failed]: null }))).toBe(true);
    }
    const bar = statusBar(input({ posts: null, briefs: 2 }));
    expect(bar.kind === 'items' ? bar.items.map((i) => i.key) : []).toEqual(['briefs']);
    expect(statusItems(input({ marks: null, posts: 1 })).map((i) => i.key)).toEqual(['posts']);
  });

  it('the drawer closes itself once the bar is no longer items', () => {
    expect(drawerShouldClose({ kind: 'empty' })).toBe(true);
    expect(drawerShouldClose({ kind: 'blank' })).toBe(true);
    expect(drawerShouldClose({ kind: 'items', items: [] })).toBe(false);
  });

  it('first paint waits for every read', () => {
    const all = { posts: true, side: true, marks: true, plans: true, briefs: true };
    expect(statusReady(all)).toBe(true);
    for (const key of Object.keys(all) as Array<keyof typeof all>) {
      expect(statusReady({ ...all, [key]: false })).toBe(false);
    }
  });
});

describe('open plans', () => {
  it('keeps plans ending today or later, soonest first', () => {
    const plans = [
      bundle('late', '2026-10-25'),
      bundle('past', '2026-10-09'),
      bundle('today', '2026-10-10'),
      bundle('soon', '2026-10-16'),
    ];
    expect(openPlans(plans, '2026-10-10').map((b) => b.plan.id)).toEqual(['today', 'soon', 'late']);
  });
});

describe('current shared plans', () => {
  it('shared only, and only when the range holds today (both ends inclusive)', () => {
    const plans = [
      bundle('draft', '2026-10-20', [], '2026-10-01', 'team'),
      bundle('ended', '2026-10-09'),
      bundle('ends-today', '2026-10-10'),
      bundle('starts-today', '2026-10-30', [], '2026-10-10'),
      bundle('future', '2026-10-30', [], '2026-10-11'),
      bundle('running', '2026-10-20'),
    ];
    expect(currentSharedPlans(plans, '2026-10-10').map((b) => b.plan.id)).toEqual([
      'ends-today',
      'running',
      'starts-today',
    ]);
  });

  it('ordered by soonest end, then start, then id (never the title)', () => {
    const a = bundle('a', '2026-10-20', [], '2026-10-05');
    const b = bundle('b', '2026-10-20', [], '2026-10-02');
    const c = bundle('c', '2026-10-20', [], '2026-10-02');
    c.plan.title = 'A first by title';
    const d = bundle('d', '2026-10-15');
    expect(currentSharedPlans([a, c, b, d], '2026-10-10').map((x) => x.plan.id)).toEqual([
      'd',
      'b',
      'c',
      'a',
    ]);
  });

  it('today is the workspace zone: late on 9 Oct UTC is 10 Oct in Kolkata', () => {
    const now = new Date('2026-10-09T20:00:00Z');
    const ends = [bundle('ends', '2026-10-09')];
    expect(currentSharedPlans(ends, todayInZone(now, 'UTC')).length).toBe(1);
    expect(currentSharedPlans(ends, todayInZone(now, 'Asia/Kolkata')).length).toBe(0);
    const starts = [bundle('starts', '2026-10-30', [], '2026-10-10')];
    expect(currentSharedPlans(starts, todayInZone(now, 'UTC')).length).toBe(0);
    expect(currentSharedPlans(starts, todayInZone(now, 'Asia/Kolkata')).length).toBe(1);
  });

  it('the read window covers today in every zone (UTC-12 to UTC+14)', () => {
    expect(currentPlanWindow(new Date('2026-10-09T20:00:00Z'))).toEqual({
      from: '2026-10-09',
      to: '2026-10-10',
    });
    expect(currentPlanWindow(new Date('2026-10-09T05:00:00Z'))).toEqual({
      from: '2026-10-08',
      to: '2026-10-09',
    });
    const now = new Date('2026-10-09T11:30:00Z');
    const range = currentPlanWindow(now);
    for (const zone of ['Pacific/Kiritimati', 'Asia/Kolkata', 'UTC', 'Etc/GMT+12']) {
      const today = todayInZone(now, zone);
      expect(today >= range.from && today <= range.to).toBe(true);
    }
  });

  it('summaries keep the order and count like the single plan did', () => {
    const current = currentSharedPlans(
      [
        bundle('b', '2026-10-25', [{ client: 'approved' }, {}]),
        bundle('a', '2026-10-16', [{ client: 'approved' }, { client: 'changes' }, {}]),
      ],
      '2026-10-10',
    );
    expect(planSummaries(current, planProgress)).toEqual([
      { id: 'a', title: 'Plan a', approved: 1, total: 3, changes: 1 },
      { id: 'b', title: 'Plan b', approved: 1, total: 2, changes: 0 },
    ]);
    expect(planSummaries([], planProgress)).toEqual([]);
  });

  it('the drawer lists each section once even with two plan items', () => {
    const items = statusItems(
      input({ plans: [summary('a', 0, 1), summary('b', 0, 1)], briefs: 2 }),
    );
    expect(drawerKeys(items)).toEqual(['plan', 'briefs']);
  });
});

describe('compact plan titles drop whole words', () => {
  it('words split on whitespace; a kept title ends on the ellipsis', () => {
    expect(titleWords('  Diwali   week  two ')).toEqual(['Diwali', 'week', 'two']);
    expect(keptTitle('Diwali week two', 3)).toBe('Diwali week two');
    expect(keptTitle('Diwali week two', 2)).toBe(`Diwali week${TITLE_ELLIPSIS}`);
    expect(keptTitle('Diwali week two', 0)).toBe(`Diwali${TITLE_ELLIPSIS}`);
  });

  it('nothing over: every word stays', () => {
    expect(titleWordsKept([[30, 20], [40]], 8, 0)).toEqual([2, 1]);
  });

  it('drops from the widest title first, never below one word', () => {
    // Title 0 is 30+20+20 = 70 wide, title 1 is 40+30 = 70: ties go to the first.
    expect(
      titleWordsKept(
        [
          [30, 20, 20],
          [40, 30],
        ],
        5,
        10,
      ),
    ).toEqual([2, 2]);
    // 30 over: title 0 drops one (saves 15), then title 1 (now widest) drops one.
    expect(
      titleWordsKept(
        [
          [30, 20, 20],
          [40, 30],
        ],
        5,
        30,
      ),
    ).toEqual([2, 1]);
    // Far over: both stop at one word.
    expect(
      titleWordsKept(
        [
          [30, 20, 20],
          [40, 30],
        ],
        5,
        999,
      ),
    ).toEqual([1, 1]);
  });
});

describe('plan rows', () => {
  it('segments: client approved, changes, team approved on the agency side only', () => {
    expect(planSegment({ client: true, changes: false, team: true }, 'agency')).toBe('client');
    expect(planSegment({ client: false, changes: true, team: true }, 'agency')).toBe('changes');
    expect(planSegment({ client: false, changes: false, team: true }, 'agency')).toBe('team');
    expect(planSegment({ client: false, changes: false, team: true }, 'client')).toBe('waiting');
    expect(planSegment({ client: false, changes: false, team: false }, 'agency')).toBe('waiting');
  });

  it('section count: A/N for one plan, N open for more', () => {
    expect(planSectionCount(1, { approved: 2, total: 5 })).toBe('2/5');
    expect(planSectionCount(3, null)).toBe('3 open');
  });
});

describe('drawer sections', () => {
  const mark = (id: string, type: ChatMark['type'], at: string, resolved = false): ChatMark => ({
    messageId: id,
    channelId: 'c',
    type,
    priority: null,
    markedAt: at,
    resolved,
    resolvedBy: null,
    resolvedAt: resolved ? at : null,
  });

  it('open marks of a type, newest first', () => {
    const marks = [
      mark('a', 'commitment', '2026-10-01T00:00:00Z'),
      mark('b', 'commitment', '2026-10-03T00:00:00Z'),
      mark('c', 'decision', '2026-10-04T00:00:00Z'),
      mark('d', 'commitment', '2026-10-05T00:00:00Z', true),
    ];
    const rows = openMarksOfType(marks, 'commitment', (m) => Date.parse(m.markedAt));
    expect(rows.map((m) => m.messageId)).toEqual(['b', 'a']);
  });

  it('first five rows then See all N', () => {
    const rows = Array.from({ length: 7 }, (_, i) => i);
    expect(sectionRows(rows)).toEqual({ rows: rows.slice(0, SECTION_ROWS), seeAll: 7 });
    expect(sectionRows(rows.slice(0, 5))).toEqual({ rows: rows.slice(0, 5), seeAll: null });
    expect(sectionRows(rows.slice(0, 3), 120).seeAll).toBe(120);
  });

  it('labels', () => {
    const labels = (
      ['plan', 'posts', 'briefs', 'commitments', 'decisions', 'pending'] as StatusKey[]
    ).map((key) => sectionLabel(key, { postsHeading: 'Posts waiting on you', plans: 1 }));
    expect(labels).toEqual([
      'Plan',
      'Posts waiting on you',
      'Open briefs',
      'Commitments',
      'Decisions',
      'Pending',
    ]);
    expect(sectionLabel('plan', { postsHeading: '', plans: 2 })).toBe('Plans');
  });

  it('date column: calendar dates as is, instants on the workspace clock', () => {
    expect(drawerDay('2026-10-12', 'UTC')).toBe('12 Oct');
    expect(drawerDay('2026-10-12T20:00:00Z', 'Asia/Kolkata')).toBe('13 Oct');
    expect(drawerDay(null, 'UTC')).toBe('');
    expect(drawerDay('nope', 'UTC')).toBe('');
  });
});
