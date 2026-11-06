import { describe, expect, it } from 'vitest';
import type { BankIdea, PlanRow } from '@/lib/chat/plans';
import { bucketWriteError } from '@/lib/buckets';
import {
  BANK_FILTER_DEFAULT,
  BANK_SORT_OPTIONS,
  PAST_DAY_ERROR,
  bankDragId,
  bankItemHref,
  bankZeroCopy,
  cameFromLabel,
  filterApplied,
  filterPills,
  ideaFilesLine,
  ideaMetaLine,
  isUntouched,
  joinNames,
  moreFilesLabel,
  needsSharedWarning,
  nudgeLine,
  planItChoice,
  planItError,
  plannedToast,
  runLimited,
  sanitizeBankFilter,
  sharedPlanWarning,
  showToClientWarning,
  sortBankIdeas,
  withoutPill,
  BANK_DRAG_TYPE,
} from './bank-parts';

function idea(id: string, over: Partial<BankIdea> = {}): BankIdea {
  return {
    id,
    plan_id: null,
    kind: 'concept',
    position: 0,
    title: id,
    description: null,
    post_id: null,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    target_date: null,
    show_to_client: false,
    archived_at: null,
    starred_at: null,
    last_active_at: '2026-10-01T00:00:00Z',
    came_from_plan_title: null,
    bucket_ids: [],
    comment_count: 0,
    file_count: 0,
    thumb: null,
    format: null,
    ...over,
  };
}

function plan(id: string, startsOn: string, endsOn: string, audience = 'team'): PlanRow {
  return {
    id,
    workspace_id: 'ws',
    title: id,
    starts_on: startsOn,
    ends_on: endsOn,
    audience,
    created_by: null,
  } as PlanRow;
}

const NOW = new Date('2026-11-06T12:00:00Z');

describe('sort, star first', () => {
  const a = idea('a', {
    last_active_at: '2026-11-01T00:00:00Z',
    created_at: '2026-09-01T00:00:00Z',
    title: 'Zebra',
  });
  const b = idea('b', {
    last_active_at: '2026-11-05T00:00:00Z',
    created_at: '2026-10-01T00:00:00Z',
    title: 'apple',
  });
  const c = idea('c', {
    last_active_at: '2026-10-01T00:00:00Z',
    created_at: '2026-08-01T00:00:00Z',
    title: 'Mango',
    starred_at: '2026-11-02T00:00:00Z',
  });

  it('lists the four sorts, Recently active first', () => {
    expect(BANK_SORT_OPTIONS.map((o) => o.label)).toEqual([
      'Recently active',
      'Newest first',
      'Oldest first',
      'Name',
    ]);
  });

  it('puts starred ideas first within every sort', () => {
    expect(sortBankIdeas([a, b, c], 'active').map((i) => i.id)).toEqual(['c', 'b', 'a']);
    expect(sortBankIdeas([a, b, c], 'newest').map((i) => i.id)).toEqual(['c', 'b', 'a']);
    expect(sortBankIdeas([a, b, c], 'oldest').map((i) => i.id)).toEqual(['c', 'a', 'b']);
    expect(sortBankIdeas([a, b, c], 'name').map((i) => i.id)).toEqual(['c', 'b', 'a']);
  });
});

describe('the 90-day cut', () => {
  it('counts a live idea untouched for more than 90 days, never an archived one', () => {
    expect(isUntouched(idea('x', { last_active_at: '2026-08-01T00:00:00Z' }), NOW)).toBe(true);
    expect(isUntouched(idea('x', { last_active_at: '2026-08-10T00:00:00Z' }), NOW)).toBe(false);
    expect(
      isUntouched(
        idea('x', { last_active_at: '2026-01-01T00:00:00Z', archived_at: '2026-02-01T00:00:00Z' }),
        NOW,
      ),
    ).toBe(false);
  });

  it('words the nudge', () => {
    expect(nudgeLine(3)).toBe('3 ideas untouched for 90 days.');
    expect(nudgeLine(1)).toBe('1 idea untouched for 90 days.');
  });
});

describe('the applied filter line', () => {
  const buckets = [{ id: 'p', name: 'Product' }];

  it('draws nothing when nothing is applied', () => {
    expect(filterPills(BANK_FILTER_DEFAULT, buckets)).toEqual([]);
    expect(filterApplied(BANK_FILTER_DEFAULT)).toBe(false);
  });

  it('labels bucket, archived and a sort other than the default', () => {
    const filter = { ...BANK_FILTER_DEFAULT, bucketId: 'p', archived: true, sort: 'name' as const };
    expect(filterPills(filter, buckets).map((p) => p.label)).toEqual([
      'Product',
      'Archived',
      'Sort: Name',
    ]);
    expect(withoutPill(filter, 'sort').sort).toBe('active');
    expect(withoutPill(filter, 'bucket').bucketId).toBeNull();
  });

  it('drops a bucket no longer listed', () => {
    expect(filterPills({ ...BANK_FILTER_DEFAULT, bucketId: 'gone' }, buckets)).toEqual([]);
  });

  it('sanitizes a stored filter', () => {
    expect(sanitizeBankFilter({ sort: 'bogus' as never })).toEqual(BANK_FILTER_DEFAULT);
    expect(sanitizeBankFilter({ archived: true, review: true }).review).toBe(false);
  });
});

describe('copy', () => {
  it('words the zero states', () => {
    expect(bankZeroCopy(BANK_FILTER_DEFAULT, false)).toBe('Ideas show up here.');
    expect(bankZeroCopy({ ...BANK_FILTER_DEFAULT, archived: true }, false)).toBe(
      'Archived ideas show up here.',
    );
    expect(bankZeroCopy(BANK_FILTER_DEFAULT, true)).toBe('Try another search or bucket.');
    expect(bankZeroCopy({ ...BANK_FILTER_DEFAULT, bucketId: 'b' }, false)).toBe(
      'Try another search or bucket.',
    );
  });

  it('words rows', () => {
    expect(
      ideaMetaLine(idea('x', { comment_count: 1, last_active_at: '2026-11-04T12:00:00Z' }), NOW),
    ).toBe('1 comment · 2 days ago');
    expect(ideaFilesLine(idea('x', { file_count: 3 }))).toBe('Idea · 3 files');
    expect(moreFilesLabel(1)).toBeNull();
    expect(moreFilesLabel(4)).toBe('+3');
    expect(cameFromLabel(idea('x'))).toBe('New idea');
    expect(cameFromLabel(idea('x', { came_from_plan_title: 'Week of 12 Oct' }))).toBe(
      'Week of 12 Oct',
    );
  });

  it('names approvers from the workspace, never a fixed name', () => {
    expect(joinNames([])).toBe('Approvers');
    expect(joinNames(['Manisha'])).toBe('Manisha');
    expect(joinNames(['A', 'B', 'C'])).toBe('A, B and C');
    expect(showToClientWarning(['Manisha'], 4)).toBe(
      'Manisha will see this idea and all 4 comments, team ones included.',
    );
  });

  it('maps the known errors', () => {
    expect(planItError('past_date')).toBe(PAST_DAY_ERROR);
    expect(PAST_DAY_ERROR).toBe("Couldn't plan it. Past days can't be planned.");
    expect(bucketWriteError('add', 'name_taken')).toBe("Couldn't add. That bucket already exists.");
    expect(bucketWriteError('save', 'invalid_name')).toBe("Couldn't save. Use 1 to 40 characters.");
  });

  it('has no em-dashes in its copy', () => {
    const lines = [
      sharedPlanWarning('Week of 9 Nov', 2),
      plannedToast('Week of 9 Nov', '2026-11-10'),
      showToClientWarning(['A', 'B'], 1),
    ];
    for (const line of lines) expect(line).not.toContain('—');
    expect(plannedToast('Week of 9 Nov', '2026-11-10')).toBe('Planned in Week of 9 Nov, 10 Nov');
  });
});

describe('Plan it branching', () => {
  const today = '2026-11-06';
  const draft = plan('draft', '2026-11-09', '2026-11-15');
  const shared = plan('shared', '2026-11-09', '2026-11-15', 'client');
  const later = plan('later', '2026-11-16', '2026-11-22');

  it('refuses a past day', () => {
    expect(planItChoice([draft], '2026-11-05', today).kind).toBe('past');
  });

  it('places at once into the one plan that covers the day', () => {
    const choice = planItChoice([draft, later], '2026-11-10', today);
    expect(choice).toEqual({ kind: 'one', plan: draft });
  });

  it('offers Make plan when none covers it', () => {
    expect(planItChoice([later], '2026-11-10', today).kind).toBe('none');
  });

  it('lists several when more than one covers it', () => {
    const choice = planItChoice([draft, shared, later], '2026-11-10', today);
    expect(choice.kind).toBe('several');
    if (choice.kind === 'several')
      expect(choice.plans.map((p) => p.id)).toEqual(['draft', 'shared']);
  });

  it('warns before a shared plan when the idea is team only', () => {
    expect(needsSharedWarning(shared, idea('x'))).toBe(true);
    expect(needsSharedWarning(shared, idea('x', { show_to_client: true }))).toBe(false);
    expect(needsSharedWarning(draft, idea('x'))).toBe(false);
    expect(sharedPlanWarning('Autumn', 3)).toBe(
      'Autumn is shared with approvers. Once it is in, they see the idea and all 3 comments.',
    );
  });
});

describe('bulk and routes', () => {
  it('keeps at most the limit in flight', async () => {
    let live = 0;
    let peak = 0;
    const tasks = Array.from({ length: 30 }, (_, i) => async () => {
      live += 1;
      peak = Math.max(peak, live);
      await Promise.resolve();
      live -= 1;
      return i;
    });
    const out = await runLimited(tasks, 12);
    expect(peak).toBeLessThanOrEqual(12);
    expect(out).toEqual(Array.from({ length: 30 }, (_, i) => i));
  });

  it('opens an idea on the bank route', () => {
    expect(bankItemHref('abc')).toBe('/plan/bank?item=abc');
  });

  it('reads only a Bank drag', () => {
    expect(bankDragId(['text/plain'], () => 'x')).toBeNull();
    expect(bankDragId([BANK_DRAG_TYPE], () => 'id-1')).toBe('id-1');
  });
});
