import { describe, expect, it } from 'vitest';
import {
  composeCreateArgs,
  composeCreatedToast,
  composeItemNote,
  composeMoves,
  composeNeedsDay,
  composeNeedsDayError,
  composePipelineUpdates,
  composePostItem,
  composeRangeProblem,
  composeSummary,
  groupPostsByDay,
  recheckComposeItems,
  skippedOutsideNote,
  splitPickedByRange,
  wordCount,
  wordCounterLabel,
  type ComposeConcept,
  type ComposeItem,
} from '@/lib/chat/plans';

const RANGE = { startsOn: '2026-10-12', endsOn: '2026-10-18' };
const ZONE = 'Asia/Kolkata';
const post = (id: string, target_date: string | null | undefined, stage = 'review') => ({
  id,
  title: `Post ${id}`,
  stage,
  target_date,
});
const concept = (key: string, day: ComposeConcept['day']): ComposeConcept => ({
  kind: 'concept',
  key,
  title: ` Concept ${key} `,
  description: ' Idea ',
  files: [{ versionId: `v-${key}`, name: 'a.png' }],
  day,
});

describe('prefill when picked', () => {
  it('inside the range gets that day; undated is No date; outside needs a day', () => {
    expect(composePostItem(post('a', '2026-10-14'), 'post', RANGE, ZONE).day).toBe('2026-10-14');
    expect(composePostItem(post('b', null), 'post', RANGE, ZONE).day).toBe('none');
    const out = composePostItem(post('c', '2026-11-02'), 'post', RANGE, ZONE);
    expect(out.day).toBeNull();
    expect(out.orig).toBe('2026-11-02');
    expect(out.chosen).toBe(false);
  });

  it('reads a timestamptz as the civil day in the workspace zone', () => {
    // 2026-10-18 20:00 UTC is 19 Oct 01:30 in Kolkata: outside the plan.
    const late = composePostItem(post('d', '2026-10-18T20:00:00Z'), 'post', RANGE, ZONE);
    expect(late.orig).toBe('2026-10-19');
    expect(late.day).toBeNull();
    // 2026-10-11 20:00 UTC is 12 Oct in Kolkata: inside.
    const early = composePostItem(post('e', '2026-10-11T20:00:00Z'), 'post', RANGE, ZONE);
    expect(early.day).toBe('2026-10-12');
    expect(composePostItem(post('e', '2026-10-11T20:00:00Z'), 'post', RANGE, 'UTC').day).toBeNull();
  });

  it('a row without target_date is never read as undated', () => {
    expect(composePostItem(post('f', undefined), 'draft', RANGE, ZONE).day).toBeNull();
  });
});

describe('notes and summary', () => {
  it('outside, move, clear and unchanged', () => {
    const out = composePostItem(post('c', '2026-11-02'), 'post', RANGE, ZONE);
    expect(composeItemNote(out)).toEqual({
      text: 'Dated Mon 2 Nov, outside this plan. Pick a day.',
      warn: true,
    });
    expect(composeItemNote({ ...out, day: '2026-10-13', chosen: true })?.text).toBe(
      'Pipeline date moves from Mon 2 Nov to Tue 13 Oct.',
    );
    expect(composeItemNote({ ...out, day: 'none', chosen: true })?.text).toBe(
      'Pipeline date Mon 2 Nov will be cleared.',
    );
    const same = composePostItem(post('a', '2026-10-14'), 'post', RANGE, ZONE);
    expect(composeItemNote(same)).toBeNull();
    expect(composeItemNote(concept('k', '2026-10-14'))).toBeNull();
  });

  it('summary: needs a day, then moves, then Ready', () => {
    const out = composePostItem(post('c', '2026-11-02'), 'post', RANGE, ZONE);
    expect(composeSummary([out])).toBe('1 item needs a day');
    expect(composeSummary([out, concept('k', null)])).toBe('2 items need a day');
    const moved: ComposeItem = { ...out, day: '2026-10-13', chosen: true };
    expect(composeSummary([moved])).toBe('1 Pipeline date will move to match');
    expect(composeSummary([moved, { ...moved, key: 'z' }])).toBe(
      '2 Pipeline dates will move to match',
    );
    expect(composeSummary([concept('k', 'none')])).toBe('Ready');
    expect(composeMoves([{ ...out, day: 'none' }])).toBe(0);
    expect(composePipelineUpdates([{ ...out, day: 'none' }, moved])).toBe(2);
  });
});

describe('needs-a-day validation', () => {
  it('lists each item; a dated post names its date', () => {
    const out = composePostItem(post('c', '2026-11-02'), 'post', RANGE, ZONE);
    const items = [out, concept('k', null), concept('ok', 'none')];
    expect(composeNeedsDay(items).map((i) => i.key)).toEqual(['c', 'k']);
    expect(composeNeedsDayError(items)).toEqual({
      heading: '2 items need a day before the plan can be created.',
      lines: ['Post c is dated Mon 2 Nov, outside this plan', ' Concept k '],
    });
    expect(composeNeedsDayError([concept('ok', 'none')])).toBeNull();
  });
});

describe('payload builder', () => {
  it('concepts in screen order, posts once, No date as null', () => {
    const a = composePostItem(post('a', '2026-10-14'), 'post', RANGE, ZONE);
    const b = composePostItem(post('b', '2026-11-02'), 'post', RANGE, ZONE);
    const items: ComposeItem[] = [
      concept('2', 'none'),
      a,
      concept('1', '2026-10-13'),
      { ...b, day: 'none', chosen: true },
      { ...a, day: '2026-10-15' },
    ];
    const args = composeCreateArgs({
      workspaceId: 'ws',
      title: '  Week  ',
      range: RANGE,
      items,
      traceId: 't',
    });
    expect(args).toEqual({
      p_workspace_id: 'ws',
      p_title: 'Week',
      p_starts_on: '2026-10-12',
      p_ends_on: '2026-10-18',
      p_trace_id: 't',
      p_concepts: [
        {
          title: 'Concept 2',
          description: 'Idea',
          attachment_version_ids: ['v-2'],
          target_date: null,
        },
        {
          title: 'Concept 1',
          description: 'Idea',
          attachment_version_ids: ['v-1'],
          target_date: '2026-10-13',
        },
      ],
      p_posts: [
        { post_id: 'a', target_date: '2026-10-14' },
        { post_id: 'b', target_date: null },
      ],
    });
  });
});

describe('range change re-check', () => {
  it('a dropped day needs a day again; an unchosen post inside is prefilled', () => {
    const out = composePostItem(post('c', '2026-10-20'), 'post', RANGE, ZONE);
    const chosen: ComposeItem = {
      ...composePostItem(post('d', '2026-10-20'), 'post', RANGE, ZONE),
      day: '2026-10-13',
      chosen: true,
    };
    const items: ComposeItem[] = [out, chosen, concept('k', '2026-10-12'), concept('n', 'none')];
    const next = recheckComposeItems(items, { startsOn: '2026-10-13', endsOn: '2026-10-25' });
    expect(next.map((i) => i.day)).toEqual(['2026-10-20', '2026-10-13', null, 'none']);
    const narrow = recheckComposeItems(next, { startsOn: '2026-10-14', endsOn: '2026-10-16' });
    expect(narrow.map((i) => i.day)).toEqual([null, null, null, 'none']);
  });

  it('dates check: order and 5 weeks', () => {
    expect(composeRangeProblem({ startsOn: '2026-10-12', endsOn: '2026-10-11' })).toBe(
      'The end date must be on or after the start date.',
    );
    expect(composeRangeProblem({ startsOn: '', endsOn: '2026-10-11' })).toBe(
      'The end date must be on or after the start date.',
    );
    expect(composeRangeProblem({ startsOn: '2026-10-12', endsOn: '2026-11-15' })).toBeNull();
    expect(composeRangeProblem({ startsOn: '2026-10-12', endsOn: '2026-11-16' })).toBe(
      'A plan can cover up to 5 weeks. Shorten the dates.',
    );
    expect(composeRangeProblem({ startsOn: '2026-10-12', endsOn: '2026-10-12' })).toBeNull();
  });
});

describe('soft word counter', () => {
  it('counts words and turns to the aim line past 50; never blocks', () => {
    expect(wordCount('  one two\nthree  ')).toBe(3);
    expect(wordCount('')).toBe(0);
    expect(wordCounterLabel('a b c')).toEqual({ label: '3 / 50 words', over: false });
    expect(wordCounterLabel(Array(50).fill('w').join(' '))).toEqual({
      label: '50 / 50 words',
      over: false,
    });
    expect(wordCounterLabel(Array(51).fill('w').join(' '))).toEqual({
      label: '51 words · aim for 50 so approvers read it all',
      over: true,
    });
  });
});

describe('toast', () => {
  it('items, plus Pipeline dates updated when any', () => {
    expect(composeCreatedToast(4, 0)).toBe('Plan created with 4 items.');
    expect(composeCreatedToast(4, 2)).toBe('Plan created with 4 items. 2 Pipeline dates updated.');
    expect(composeCreatedToast(1, 1)).toBe('Plan created with 1 item. 1 Pipeline date updated.');
  });
});

describe('existing plan: header "+" split (F)', () => {
  it('inside and undated go now; outside waits; grouped by day; skip note', () => {
    const split = splitPickedByRange(
      [
        post('in', '2026-10-14'),
        post('none', null),
        post('out', '2026-11-02'),
        post('late', '2026-10-18T20:00:00Z'),
      ],
      RANGE,
      ZONE,
    );
    expect(split.now).toEqual(['in', 'none']);
    expect(split.outside.map((p) => p.id)).toEqual(['out', 'late']);
    expect(
      groupPostsByDay([
        { postId: 'out', day: '2026-10-13' },
        { postId: 'late', day: '2026-10-15' },
        { postId: 'x', day: '2026-10-13' },
        { postId: 'x', day: '2026-10-13' },
      ]),
    ).toEqual([
      { day: '2026-10-13', postIds: ['out', 'x'] },
      { day: '2026-10-15', postIds: ['late'] },
    ]);
    expect(groupPostsByDay([])).toEqual([]);
    expect(skippedOutsideNote('Festive teaser')).toBe(
      'Festive teaser was not added: its date is outside this plan.',
    );
  });
});
