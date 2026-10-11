import { describe, expect, it } from 'vitest';
import { planProgress, todayInZone } from '@/components/chat/plan-card';
import type { ChatMark, MarkCounts } from '@/lib/chat/marks';
import type { PlanBundle, PlanItemRow } from '@/lib/chat/plans';
import {
  NOTHING_OPEN_LINE,
  SECTION_ROWS,
  STATUS_ORDER,
  anyReadFailed,
  capCount,
  distinctPlanIds,
  drawerDay,
  drawerShouldClose,
  openMarksOfType,
  openPlans,
  planSectionCount,
  planSegment,
  planSummary,
  planTone,
  postsWord,
  sectionLabel,
  sectionRows,
  statusBar,
  statusItems,
  statusReady,
  type StatusInput,
  type StatusKey,
} from '@/lib/chat/status-bar';

const NO_MARKS: MarkCounts = { commitments: 0, decisions: 0, pending: 0, p1: 0 };

function input(over: Partial<StatusInput> = {}): StatusInput {
  return { plan: 'none', posts: 0, briefs: 0, marks: NO_MARKS, side: 'agency', ...over };
}

function bundle(
  id: string,
  endsOn: string,
  items: Array<{ client?: 'approved' | 'changes'; team?: 'approved' }> = [],
  startsOn = '2026-10-01',
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
      audience: 'client',
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

describe('statusItems: every on/off combination of the six items', () => {
  it('all 64 combos: fixed order, zero items omitted, the rest close up', () => {
    for (let mask = 0; mask < 64; mask += 1) {
      const on = (bit: number): boolean => (mask & (1 << bit)) !== 0;
      const items = statusItems(
        input({
          plan: on(0) ? { approved: 1, total: 3, changes: 0, more: 0 } : 'none',
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
          plan: on(0) ? { approved: 1, total: 3, changes: 0, more: 0 } : 'none',
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
    const [plan] = statusItems(input({ plan: { approved: 100, total: 140, changes: 0, more: 0 } }));
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

  it('the plan keeps "Plan", shows A/N and +K', () => {
    const [plan] = statusItems(input({ plan: { approved: 2, total: 5, changes: 0, more: 1 } }));
    expect(plan).toMatchObject({ lead: 'Plan', number: '2/5', word: null, more: 1 });
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
    expect(NOTHING_OPEN_LINE).toBe('Nothing open between you');
  });

  it('a failed read never yields empty, and omits only its own item', () => {
    for (const failed of ['plan', 'posts', 'briefs', 'marks'] as const) {
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

  it('ends_on filter uses the workspace zone: late on 9 Oct UTC is 10 Oct in Kolkata', () => {
    const now = new Date('2026-10-09T20:00:00Z');
    const plans = [bundle('p', '2026-10-09')];
    expect(openPlans(plans, todayInZone(now, 'UTC')).length).toBe(1);
    expect(openPlans(plans, todayInZone(now, 'Asia/Kolkata')).length).toBe(0);
  });

  it('the bar picks the soonest-ending plan and counts the rest as +K', () => {
    const open = openPlans(
      [
        bundle('b', '2026-10-25', [{ client: 'approved' }, {}]),
        bundle('a', '2026-10-16', [{ client: 'approved' }, { client: 'changes' }, {}]),
      ],
      '2026-10-10',
    );
    expect(planSummary(open, planProgress)).toEqual({
      approved: 1,
      total: 3,
      changes: 1,
      more: 1,
    });
    expect(planSummary([], planProgress)).toBe('none');
  });

  it('distinct plan ids over message rows', () => {
    expect(
      distinctPlanIds([
        { shared_plan_ids: ['a', 'b'] },
        { shared_plan_ids: null },
        { shared_plan_ids: [] },
        { shared_plan_ids: ['b', 'c', ''] },
      ]),
    ).toEqual(['a', 'b', 'c']);
  });

  it('segments: client approved, changes, team approved on the agency side only', () => {
    expect(planSegment({ client: true, changes: false, team: true }, 'agency')).toBe('client');
    expect(planSegment({ client: false, changes: true, team: true }, 'agency')).toBe('changes');
    expect(planSegment({ client: false, changes: false, team: true }, 'agency')).toBe('team');
    expect(planSegment({ client: false, changes: false, team: true }, 'client')).toBe('waiting');
    expect(planSegment({ client: false, changes: false, team: false }, 'agency')).toBe('waiting');
  });

  it('section count: A/N for one plan, N open for more', () => {
    expect(planSectionCount(1, { approved: 2, total: 5, changes: 0, more: 0 })).toBe('2/5');
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
