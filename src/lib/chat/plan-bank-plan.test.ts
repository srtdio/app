// Bank meets Plan (PR C): the rows' bucket line, the moved-to-bank traces and
// the review line of an idea planned from the bank. Pure; no database.
import { describe, expect, it } from 'vitest';
import {
  bucketLine,
  reduceBankTraces,
  traceDayOf,
  rowBucketsOf,
  tracesByDay,
  type PlanBundle,
  type TraceAuditRow,
  type TraceItemRow,
} from '@/lib/chat/plans';
import { planControlText, reviewStatus } from '@/components/chat/plan-card';
import { movedToBankLine, moveToBankError, MOVE_TO_BANK_LOCKED } from '@/lib/chat/bank-plan-copy';

describe('bucket line', () => {
  it('format · buckets, either alone, nothing when neither', () => {
    expect(bucketLine('Reel', ['Launch', 'Tips'])).toBe('Reel · Launch, Tips');
    expect(bucketLine('Reel', [])).toBe('Reel');
    expect(bucketLine('', ['Launch'])).toBe('Launch');
    expect(bucketLine(null, ['Launch', ' '])).toBe('Launch');
    expect(bucketLine(undefined, [])).toBe('');
  });

  it('never an em-dash', () => {
    expect(bucketLine('Reel', ['A', 'B'])).not.toContain('—');
  });

  it('rows: a concept reads its buckets in bucket order; a post its one bucket', () => {
    const buckets = rowBucketsOf(
      [
        { item_id: 'c1', bucket_id: 'b2', workspace_buckets: { name: 'Tips', position: 2 } },
        { item_id: 'c1', bucket_id: 'b1', workspace_buckets: [{ name: 'Launch', position: 1 }] },
        { item_id: 'c2', bucket_id: 'b3', workspace_buckets: null },
      ],
      [
        { id: 'p1', bucket_id: 'b1', workspace_buckets: { name: 'Launch' } },
        { id: 'p2', bucket_id: null, workspace_buckets: null },
      ],
    );
    expect(buckets.items).toEqual({ c1: ['Launch', 'Tips'] });
    expect(buckets.posts).toEqual({ p1: ['Launch'] });
  });
});

describe('moved-to-bank traces', () => {
  const plan = { id: 'plan-a', starts_on: '2026-11-02', ends_on: '2026-11-08' };
  const other = { id: 'plan-b', starts_on: '2026-11-09', ends_on: '2026-11-15' };
  const row = (id: string, at: string, from: string): TraceAuditRow => ({
    entity_id: id,
    created_at: at,
    payload: { from_plan_id: from },
  });
  const item = (id: string, planId: string | null, title = id): TraceItemRow => ({
    id,
    plan_id: planId,
    title,
  });

  it('newest trace per item, on the move day in the zone, newest first', () => {
    const out = reduceBankTraces(
      [
        row('i1', '2026-11-03T10:00:00Z', 'plan-a'),
        row('i2', '2026-11-05T10:00:00Z', 'plan-a'),
        row('i1', '2026-11-04T23:30:00Z', 'plan-a'),
      ],
      [item('i1', null, 'Teaser'), item('i2', null, 'Poll')],
      [plan],
      'Asia/Kolkata',
    );
    const list = out.get('plan-a') ?? [];
    expect(list.map((t) => t.itemId)).toEqual(['i2', 'i1']);
    // 23:30 UTC on the 4th is the 5th in Kolkata.
    expect(list.find((t) => t.itemId === 'i1')?.day).toBe('2026-11-05');
    expect(list.find((t) => t.itemId === 'i1')?.title).toBe('Teaser');
  });

  it('dropped when the item is back in this plan, gone, or its newest move left another plan', () => {
    const out = reduceBankTraces(
      [
        row('back', '2026-11-03T10:00:00Z', 'plan-a'),
        row('gone', '2026-11-03T10:00:00Z', 'plan-a'),
        row('moved', '2026-11-03T10:00:00Z', 'plan-a'),
        row('moved', '2026-11-10T10:00:00Z', 'plan-b'),
      ],
      [item('back', 'plan-a'), item('moved', null)],
      [plan, other],
      'UTC',
    );
    expect(out.get('plan-a')).toBeUndefined();
    expect(out.get('plan-b')?.map((t) => t.itemId)).toEqual(['moved']);
  });

  it('the day the concept sat on (payload target_date) wins over the move day', () => {
    const out = reduceBankTraces(
      [
        {
          entity_id: 'sat',
          created_at: '2026-11-20T10:00:00Z',
          payload: { from_plan_id: 'plan-a', target_date: '2026-11-04' },
        },
        // An older row (no target_date) or a concept with no day: the clamp.
        {
          entity_id: 'old',
          created_at: '2026-11-20T10:00:00Z',
          payload: { from_plan_id: 'plan-a', target_date: null },
        },
      ],
      [item('sat', null), item('old', null)],
      [plan],
      'UTC',
    );
    const list = out.get('plan-a') ?? [];
    expect(list.find((t) => t.itemId === 'sat')?.day).toBe('2026-11-04');
    expect(list.find((t) => t.itemId === 'old')?.day).toBe('2026-11-08');
    expect(traceDayOf({ target_date: '2026-11-04' })).toBe('2026-11-04');
    expect(traceDayOf({ target_date: 'nope' })).toBeNull();
    expect(traceDayOf(null)).toBeNull();
  });

  it('a move outside the range sits on the nearest plan day', () => {
    const out = reduceBankTraces(
      [
        row('late', '2026-11-20T10:00:00Z', 'plan-a'),
        row('early', '2026-10-01T10:00:00Z', 'plan-a'),
      ],
      [item('late', null), item('early', null)],
      [plan],
      'UTC',
    );
    const days = Object.fromEntries((out.get('plan-a') ?? []).map((t) => [t.itemId, t.day]));
    expect(days).toEqual({ late: '2026-11-08', early: '2026-11-02' });
  });

  it('rows without an item id or a from_plan_id are skipped', () => {
    const out = reduceBankTraces(
      [
        {
          entity_id: null,
          created_at: '2026-11-03T10:00:00Z',
          payload: { from_plan_id: 'plan-a' },
        },
        { entity_id: 'x', created_at: '2026-11-03T10:00:00Z', payload: null },
      ],
      [item('x', null)],
      [plan],
      'UTC',
    );
    expect(out.size).toBe(0);
  });

  it('groups by day; the line reads "{title} moved to bank"', () => {
    const out = reduceBankTraces(
      [row('a', '2026-11-03T10:00:00Z', 'plan-a'), row('b', '2026-11-03T12:00:00Z', 'plan-a')],
      [item('a', null, 'Teaser'), item('b', null, null as unknown as string)],
      [plan],
      'UTC',
    );
    const days = tracesByDay(out.get('plan-a') ?? []);
    expect(days.get('2026-11-03')?.map((t) => t.itemId)).toEqual(['b', 'a']);
    expect(movedToBankLine('Teaser')).toBe('Teaser moved to bank');
    expect(movedToBankLine(null)).toBe('Untitled idea moved to bank');
  });

  it('the Plan screen reads traces for the agency only', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(
      new URL('../../components/chat/PlanScreen.tsx', import.meta.url),
      'utf8',
    );
    expect(src).toMatch(/useBankTraces\(\{[\s\S]*?enabled: props\.open && side === 'agency'/);
    expect(src).toMatch(/\{\.\.\.\(agency \? \{ traces: dayTraces \} : \{\}\)\}/);
  });
});

describe('move to bank copy', () => {
  it('post_approved reads locked; anything else the plain line', () => {
    expect(moveToBankError('post_approved')).toBe(MOVE_TO_BANK_LOCKED);
    expect(MOVE_TO_BANK_LOCKED).toBe("Couldn't move to bank. Approved posts are locked.");
    expect(moveToBankError('boom')).toMatch(/^Couldn't move to bank\./);
  });
});

describe('an idea planned from the bank starts unchecked', () => {
  it('no review row: the PLAN line reads "Not checked yet" on both sides', () => {
    const bundle = {
      plan: {
        id: 'p',
        workspace_id: 'w',
        title: 'Week',
        starts_on: '2026-11-02',
        ends_on: '2026-11-08',
        audience: 'team',
        created_by: null,
      },
      items: [
        {
          id: 'from-bank',
          plan_id: 'p',
          kind: 'concept',
          position: 0,
          title: 'Idea',
          description: null,
          post_id: null,
          created_at: '2026-11-01T00:00:00Z',
          target_date: '2026-11-04',
        },
      ],
      reviews: [],
      postStages: {},
      postInfo: {},
    } as PlanBundle;
    expect(planControlText(reviewStatus(bundle, 'from-bank', 'team'))).toBe('Not checked yet');
    expect(planControlText(reviewStatus(bundle, 'from-bank', 'client'))).toBe('Not checked yet');
  });
});
