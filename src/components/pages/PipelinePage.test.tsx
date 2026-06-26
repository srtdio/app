import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';

vi.mock('@/lib/events', () => ({ dispatchSorted: vi.fn() }));

// Only the proc call is mocked; the transition map, types, and reads stay real.
vi.mock('@srtdio/posts', async () => {
  const actual = await vi.importActual<typeof import('@srtdio/posts')>('@srtdio/posts');
  return { ...actual, stageTransition: vi.fn() };
});

// The unit env is `node` with no DOM. PipelineSortControl is the only component
// here invoked as a plain function (every other surface is a pure helper or an
// unexpanded element node), so we mock the two hooks it touches: useMediaQuery is
// stubbed to a fixed breakpoint, and useState is a pure shim that records its
// setters per call index (0 = sheet/popover open, 1 = calendar open) so a test
// can force initial state and observe a setter firing without a renderer.
vi.mock('@/lib/use-media-query', () => ({ useMediaQuery: () => true }));

const hookState = vi.hoisted(() => ({
  index: 0,
  overrides: {} as Record<number, unknown>,
  calls: [] as unknown[][],
  reset(): void {
    this.index = 0;
    this.overrides = {};
    this.calls = [];
  },
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: (init: unknown) => {
      const i = hookState.index;
      const base = typeof init === 'function' ? (init as () => unknown)() : init;
      const value = i in hookState.overrides ? hookState.overrides[i] : base;
      const setter = (next: unknown): void => {
        hookState.calls[i] = (hookState.calls[i] ?? []).concat([next]);
      };
      hookState.index += 1;
      return [value, setter];
    },
  };
});

import {
  MOVE_FALLBACK_MESSAGE,
  moveErrorMessage,
  pipelineHeader,
  postCountLabel,
  runMovePost,
  sanitizePostSort,
  stageCounts,
} from '@/components/pages/PipelinePage';
import type { MovePostDeps } from '@/components/pages/PipelinePage';
import {
  PipelineSortControl,
  customRangeLabel,
  sortControlBody,
} from '@/components/pages/pipeline/PipelineSortControl';
import { PipelineDateRangeCalendar } from '@/components/pages/pipeline/PipelineDateRangeCalendar';
import { dispatchSorted } from '@/lib/events';
import { STAGE_TRANSITIONS, stageTransition } from '@srtdio/posts';
import type { Client, PipelinePost, Result, Stage } from '@srtdio/posts';
import { groupByStage } from '@/lib/post-board';
import {
  POST_SORT_DEFAULT,
  filterByFields,
  filterByTitle,
  filterByWindow,
  sortByDate,
  type DateWindow,
} from '@/lib/list-sort';
import { SectionHeader } from '@/components/shell/SectionHeader';
import { SortMenu } from '@/components/ui/SortMenu';
import { StageChips } from '@/components/pages/pipeline/StageChips';

const STAGES = Object.keys(STAGE_TRANSITIONS) as Stage[];
const stMock = vi.mocked(stageTransition);

function makePost(id: string, stage: Stage): PipelinePost {
  return {
    id,
    workspace_id: 'w',
    title: `Post ${id}`,
    stage,
    platform: 'instagram',
    format: 'reel',
    origin: 'manual',
    legacy_author_name: null,
    caption: null,
    brief_id: null,
    bucket_id: null,
    owner_user_id: 'u',
    created_by: 'u',
    target_date: null,
    deleted_at: null,
    row_version: 1,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    stage_entered_at: '2026-01-01',
    thumbnailAssetVersionId: null,
  };
}

/** A deps harness whose setPosts/onClose/toast effects are observable in the test. */
function harness(posts: PipelinePost[]): {
  deps: MovePostDeps;
  state: () => PipelinePost[];
  toasts: string[];
  closed: () => boolean;
  setPostsCalls: () => number;
} {
  let current = posts;
  let wasClosed = false;
  let setCalls = 0;
  const toasts: string[] = [];
  const deps: MovePostDeps = {
    client: {} as Client,
    posts,
    inFlight: new Set<string>(),
    setPosts: (updater) => {
      setCalls += 1;
      current = updater(current);
    },
    onClose: () => {
      wasClosed = true;
    },
    toast: (message) => toasts.push(message),
  };
  return {
    deps,
    state: () => current,
    toasts,
    closed: () => wasClosed,
    setPostsCalls: () => setCalls,
  };
}

function isElement(node: ReactNode): node is ReactElement {
  return typeof node === 'object' && node !== null && 'props' in node;
}

// SectionHeader is hookless and holds search/sort/primaryAction in props, so it
// is expanded by calling its render once (mirroring SectionHeader's own tests)
// while leaving stateful children (SortMenu, StageChips) as unexpanded elements.
function expandSectionHeader(el: ReactElement): ReactElement {
  return (el.type as unknown as (props: unknown) => ReactElement)(el.props);
}

function collect(node: ReactNode, found: ReactElement[]): void {
  if (Array.isArray(node)) {
    node.forEach((child) => collect(child, found));
    return;
  }
  if (!isElement(node)) return;
  found.push(node);
  if (node.type === SectionHeader) {
    collect(expandSectionHeader(node), found);
    return;
  }
  collect((node.props as { children?: ReactNode }).children, found);
}

function findAll(tree: ReactNode, predicate: (el: ReactElement) => boolean): ReactElement[] {
  const all: ReactElement[] = [];
  collect(tree, all);
  return all.filter(predicate);
}

function texts(tree: ReactNode): string[] {
  const out: string[] = [];
  const all: ReactElement[] = [];
  collect(tree, all);
  for (const el of all) {
    const child = (el.props as { children?: ReactNode }).children;
    if (typeof child === 'string') out.push(child);
  }
  return out;
}

function header(): ReactElement {
  return pipelineHeader({
    search: '',
    onSearchChange: () => {},
    sort: 'updated',
    onSortChange: () => {},
    dateWindow: 'any',
    onDateWindowChange: () => {},
    customRange: null,
    onCustomRangeChange: () => {},
    weekStartDay: 1,
    stage: 'all',
    onStageChange: () => {},
    counts: { all: 3, draft: 2, review: 1 },
  });
}

describe('pipelineHeader', () => {
  it('uses the shared SectionHeader with the consolidated sort node (no raw SortMenu)', () => {
    const tree = header();
    expect(findAll(tree, (el) => el.type === SectionHeader)).toHaveLength(1);
    // The header now hands SectionHeader a node, not the declarative SortMenu.
    expect(findAll(tree, (el) => el.type === SortMenu)).toHaveLength(0);
    expect(findAll(tree, (el) => el.type === PipelineSortControl)).toHaveLength(1);
  });

  it('passes the sort to SectionHeader as a { node } (PipelineSortControl)', () => {
    const headers = findAll(header(), (el) => el.type === SectionHeader);
    expect(headers).toHaveLength(1);
    const sort = (headers[0]!.props as { sort: { node?: ReactElement } }).sort;
    expect(sort.node).toBeDefined();
    expect((sort.node as ReactElement).type).toBe(PipelineSortControl);
  });

  it('wires the active order and date-window state through to the control', () => {
    const controls = findAll(header(), (el) => el.type === PipelineSortControl);
    expect(controls).toHaveLength(1);
    const props = controls[0]!.props as {
      order: string;
      dateWindow: string;
      customRange: unknown;
      weekStartDay: number;
    };
    expect(props.order).toBe('updated');
    expect(props.dateWindow).toBe('any');
    expect(props.customRange).toBeNull();
    expect(props.weekStartDay).toBe(1);
  });

  it('dispatches sorted:create-post from the "+" action', () => {
    const button = findAll(
      header(),
      (el) => (el.props as { 'aria-label'?: string })['aria-label'] === 'Create post',
    );
    expect(button).toHaveLength(1);
    (button[0]!.props as { onClick: () => void }).onClick();
    expect(dispatchSorted).toHaveBeenCalledWith('sorted:create-post');
  });

  it('keeps the stage chip bar in the filter slot', () => {
    const chips = findAll(header(), (el) => el.type === StageChips);
    expect(chips).toHaveLength(1);
    const items = (chips[0]!.props as { items: { key: string; label: string; count: number }[] })
      .items;
    expect(items.map((t) => t.key)).toContain('all');
    // Label and count are discrete fields now, not a concatenated badge string.
    const all = items.find((t) => t.key === 'all');
    expect(all?.label).toBe('All');
    expect(all?.count).toBe(3);
  });

  it('drops the dead Sort button and decorative add-chips', () => {
    const labels = texts(header());
    expect(labels).not.toContain('Sort');
    expect(labels).not.toContain('+ Owner');
    expect(labels).not.toContain('+ Bucket');
    expect(labels).not.toContain('+ Date');
  });
});

describe('honest post counter (fix 3)', () => {
  // Mirror PipelinePage's derivation exactly: filter -> sort -> group -> count ->
  // label. The header counter must read this filtered total (counts.all), never
  // the raw unfiltered posts.length and never a per-stage display cap.
  function deriveLabel(posts: PipelinePost[], search: string): string {
    const grouped = groupByStage(sortByDate(filterByTitle(posts, search), 'newest'), STAGES);
    return postCountLabel(stageCounts(grouped, STAGES).all ?? 0);
  }

  const posts: PipelinePost[] = [
    { ...makePost('1', 'draft'), title: 'Alpha launch' },
    { ...makePost('2', 'review'), title: 'Beta teaser' },
    { ...makePost('3', 'approved'), title: 'Beta recap' },
    { ...makePost('4', 'parked'), title: 'Gamma promo' },
    { ...makePost('5', 'rejected'), title: 'Delta note' },
  ];

  it('reflects the full total when the search is empty', () => {
    expect(deriveLabel(posts, '')).toBe('5 posts');
  });

  it('reflects the FILTERED total under an active search (not the unfiltered length)', () => {
    // "beta" matches two posts spread across two stages.
    expect(deriveLabel(posts, 'beta')).toBe('2 posts');
    // A single match is singularised.
    expect(deriveLabel(posts, 'alpha')).toBe('1 post');
    // Guard: the counter must move with the search, never revert to posts.length.
    expect(deriveLabel(posts, 'alpha')).not.toBe(postCountLabel(posts.length));
  });

  it('counts the filtered total across stages, never the per-stage display cap', () => {
    const many: PipelinePost[] = Array.from({ length: 25 }, (_unused, i) => ({
      ...makePost(`m${i}`, 'draft'),
      title: 'Capped item',
    }));
    // 25 matches in one stage: the filtered total, not a cap of 10.
    expect(deriveLabel(many, 'capped')).toBe('25 posts');
  });
});

describe('moveErrorMessage', () => {
  it('maps proc codes to friendly copy without leaking the raw code', () => {
    expect(moveErrorMessage('invalid_stage_transition')).toBe(
      'That move is not allowed from this stage.',
    );
    expect(moveErrorMessage('forbidden_role')).toBe(
      'You do not have permission to move this post.',
    );
    expect(moveErrorMessage('workspace_member_only')).toBe(
      'You do not have permission to move this post.',
    );
    expect(moveErrorMessage('unknown')).toBe('Could not move the post. Please try again.');
  });
});

describe('runMovePost', () => {
  afterEach(() => {
    stMock.mockReset();
  });

  it('success: calls the proc with {postId,toStage}, re-groups, closes, and toasts', async () => {
    stMock.mockResolvedValue({ ok: true, data: 'ok' } satisfies Result<string>);
    const h = harness([makePost('p1', 'draft')]);

    await runMovePost(h.deps, 'p1', 'review');

    expect(stMock).toHaveBeenCalledTimes(1);
    expect(stMock).toHaveBeenCalledWith(h.deps.client, { postId: 'p1', toStage: 'review' });
    // The post re-groups into the new stage column.
    const grouped = groupByStage(h.state(), STAGES);
    expect(grouped.review.map((p) => p.id)).toEqual(['p1']);
    expect(grouped.draft).toHaveLength(0);
    expect(h.closed()).toBe(true);
    expect(h.toasts).toEqual(['"Post p1" moved to Review']);
  });

  it('failure: leaves the post in place, toasts a friendly error, no stage change', async () => {
    stMock.mockResolvedValue({
      ok: false,
      error: { code: 'invalid_stage_transition', message: 'invalid_stage_transition' },
    } satisfies Result<string>);
    const h = harness([makePost('p1', 'draft')]);

    await runMovePost(h.deps, 'p1', 'approved');

    expect(h.setPostsCalls()).toBe(0);
    expect(h.state()[0]!.stage).toBe('draft');
    expect(h.closed()).toBe(false);
    expect(h.toasts).toEqual([moveErrorMessage('invalid_stage_transition')]);
  });

  it('transport failure: a thrown proc toasts the fallback error, leaves the post put, and clears the in-flight guard', async () => {
    stMock.mockRejectedValue(new Error('network down'));
    const h = harness([makePost('p1', 'draft')]);

    // Must not reject: the catch swallows the throw into a toast. If the catch is
    // removed this await rejects and the test fails.
    await runMovePost(h.deps, 'p1', 'review');

    expect(h.setPostsCalls()).toBe(0);
    expect(h.state()[0]!.stage).toBe('draft');
    expect(h.closed()).toBe(false);
    expect(h.toasts).toEqual([MOVE_FALLBACK_MESSAGE]);
    // The double-fire guard cleared on failure exactly as on success.
    expect(h.deps.inFlight.has('p1')).toBe(false);
  });

  it('double-fire guard: two rapid calls for the same post fire the proc once', async () => {
    let resolve: ((value: Result<string>) => void) | undefined;
    stMock.mockReturnValue(
      new Promise<Result<string>>((r) => {
        resolve = r;
      }),
    );
    const h = harness([makePost('p1', 'draft')]);

    const first = runMovePost(h.deps, 'p1', 'review');
    const second = runMovePost(h.deps, 'p1', 'review');

    expect(stMock).toHaveBeenCalledTimes(1);
    resolve?.({ ok: true, data: 'ok' });
    await Promise.all([first, second]);
    expect(stMock).toHaveBeenCalledTimes(1);
  });
});

describe('persisted sort sanitization (fix 1)', () => {
  it('heals a stale stored value the trimmed menu no longer lists', () => {
    // Live workspaces stored 'newest'/'oldest'/'title' before the trim.
    expect(sanitizePostSort('newest')).toBe(POST_SORT_DEFAULT);
    expect(sanitizePostSort('oldest')).toBe(POST_SORT_DEFAULT);
    expect(sanitizePostSort('title')).toBe(POST_SORT_DEFAULT);
  });

  it('passes a still-listed value through untouched', () => {
    expect(sanitizePostSort('updated')).toBe('updated');
    expect(sanitizePostSort('target')).toBe('target');
  });

  it("the header's active order is the sanitized default for a stale persisted value", () => {
    // Mirror the page: a stale localStorage value (seed sorted:sort:pipeline =
    // 'newest') is sanitized before it reaches the consolidated control's order.
    const activeSort = sanitizePostSort('newest');
    const tree = pipelineHeader({
      search: '',
      onSearchChange: () => {},
      sort: activeSort,
      onSortChange: () => {},
      dateWindow: 'any',
      onDateWindowChange: () => {},
      customRange: null,
      onCustomRangeChange: () => {},
      weekStartDay: 1,
      stage: 'all',
      onStageChange: () => {},
      counts: { all: 0 },
    });
    const controls = findAll(tree, (el) => el.type === PipelineSortControl);
    expect((controls[0]!.props as { order: string }).order).toBe(POST_SORT_DEFAULT);
  });
});

describe('PipelineSortControl (consolidated sort + date window)', () => {
  // The first string child of a radio row is its visible label (the check span
  // and trailing icon carry no text).
  function rowLabel(button: ReactElement): string {
    const all: ReactElement[] = [];
    collect(button, all);
    for (const el of all) {
      const child = (el.props as { children?: ReactNode }).children;
      if (typeof child === 'string') return child;
    }
    return '';
  }
  function groupRows(group: ReactElement): ReactElement[] {
    return findAll(group, (el) => (el.props as { role?: string }).role === 'menuitemradio');
  }
  function groupsByLabel(tree: ReactNode): Record<string, ReactElement> {
    const found = findAll(tree, (el) => (el.props as { role?: string }).role === 'group');
    const out: Record<string, ReactElement> = {};
    for (const g of found) out[(g.props as { 'aria-label': string })['aria-label']] = g;
    return out;
  }
  function body(over: Partial<Parameters<typeof sortControlBody>[0]> = {}): ReactElement {
    return sortControlBody({
      order: 'updated',
      onOrderChange: () => {},
      dateWindow: 'any',
      onDateWindowChange: () => {},
      customRange: null,
      onCustomOpen: () => {},
      ...over,
    });
  }

  it('offers two labelled groups: Order and Target date', () => {
    expect(Object.keys(groupsByLabel(body())).sort()).toEqual(['Order', 'Target date']);
  });

  it('Order lists exactly Recently updated and Target date and fires onOrderChange', () => {
    let picked: string | null = null;
    const g = groupsByLabel(
      body({
        onOrderChange: (o) => {
          picked = o;
        },
      }),
    );
    const rows = groupRows(g.Order!);
    expect(rows.map(rowLabel)).toEqual(['Recently updated', 'Target date']);
    (rows[1]!.props as { onClick: () => void }).onClick();
    expect(picked).toBe('target');
  });

  it('Target date lists Any time/This week/This month plus a Custom row', () => {
    const rows = groupRows(groupsByLabel(body())['Target date']!);
    expect(rows.map(rowLabel)).toEqual(['Any time', 'This week', 'This month', 'Custom…']);
  });

  it('fires onDateWindowChange from a preset row', () => {
    let picked: string | null = null;
    const g = groupsByLabel(
      body({
        onDateWindowChange: (w) => {
          picked = w;
        },
      }),
    );
    const week = groupRows(g['Target date']!).find((r) => rowLabel(r) === 'This week')!;
    (week.props as { onClick: () => void }).onClick();
    expect(picked).toBe('week');
  });

  it('labels the Custom row from the active range', () => {
    expect(customRangeLabel(null)).toBe('Custom…');
    expect(customRangeLabel({ start: '2026-06-24', end: '2026-06-24' })).toBe('24 Jun');
    expect(customRangeLabel({ start: '2026-06-24', end: '2026-06-27' })).toBe('24 Jun – 27 Jun');
  });

  it('tapping the Custom row opens the calendar (flips the calendar-open state)', () => {
    hookState.reset();
    hookState.overrides[0] = true; // force the popover open so the body renders
    const tree = PipelineSortControl({
      order: 'updated',
      onOrderChange: () => {},
      dateWindow: 'any',
      onDateWindowChange: () => {},
      customRange: null,
      onCustomRangeChange: () => {},
      weekStartDay: 1,
    });
    const custom = findAll(
      tree,
      (el) => (el.props as { role?: string }).role === 'menuitemradio',
    ).find((r) => rowLabel(r) === 'Custom…')!;
    (custom.props as { onClick: () => void }).onClick();
    // index 1 is the calendar-open useState; tapping Custom sets it true.
    expect(hookState.calls[1]).toEqual([true]);
  });

  it('applying a range fires onCustomRangeChange and switches the window to custom', () => {
    hookState.reset();
    hookState.overrides[1] = true; // calendar open
    let range: { start: string; end: string } | null = null;
    let chosen: string | null = null;
    const tree = PipelineSortControl({
      order: 'updated',
      onOrderChange: () => {},
      dateWindow: 'any',
      onDateWindowChange: (w) => {
        chosen = w;
      },
      customRange: null,
      onCustomRangeChange: (r) => {
        range = r;
      },
      weekStartDay: 1,
    });
    const calendars = findAll(tree, (el) => el.type === PipelineDateRangeCalendar);
    expect(calendars).toHaveLength(1);
    const cal = calendars[0]!.props as {
      open: boolean;
      onApply: (r: { start: string; end: string }) => void;
    };
    expect(cal.open).toBe(true);
    cal.onApply({ start: '2026-06-24', end: '2026-06-27' });
    expect(range).toEqual({ start: '2026-06-24', end: '2026-06-27' });
    expect(chosen).toBe('custom');
  });
});

describe('target-date window narrows every surface (fix A)', () => {
  // Mirror PipelinePage's derivation: filterByFields -> filterByWindow -> count.
  // Fixed now: Wed 2026-06-17 12:00 UTC, so the Mon-Sun week is 2026-06-15..21
  // and the month is June 2026.
  const now = new Date('2026-06-17T12:00:00Z');
  function deriveCount(posts: PipelinePost[], dateWindow: DateWindow): number {
    const filtered = filterByWindow(
      filterByFields(posts, '', (p) => [p.title, p.caption, p.platform]),
      dateWindow,
      { now, timeZone: 'UTC', weekStartDay: 1 },
    );
    return stageCounts(groupByStage(filtered, STAGES), STAGES).all ?? 0;
  }
  const posts: PipelinePost[] = [
    { ...makePost('a', 'draft'), target_date: '2026-06-16T00:00:00Z' }, // this week + month
    { ...makePost('b', 'review'), target_date: '2026-06-28T00:00:00Z' }, // this month, not week
    { ...makePost('c', 'approved'), target_date: '2026-08-01T00:00:00Z' }, // outside both
    { ...makePost('d', 'parked'), target_date: null }, // no target
  ];

  it("'Any time' counts every post including a null target", () => {
    expect(deriveCount(posts, 'any')).toBe(4);
  });

  it("'This week' narrows to posts dated inside the current week", () => {
    expect(deriveCount(posts, 'week')).toBe(1);
  });

  it("'This month' narrows to posts dated inside the current month", () => {
    expect(deriveCount(posts, 'month')).toBe(2);
  });

  it("'custom' narrows the derivation to the inclusive picked range", () => {
    // Mirror the page derivation with a custom range covering only post 'a'.
    const filtered = filterByWindow(
      filterByFields(posts, '', (p) => [p.title, p.caption, p.platform]),
      'custom',
      {
        now,
        timeZone: 'UTC',
        weekStartDay: 1,
        customRange: { start: '2026-06-16', end: '2026-06-16' },
      },
    );
    const count = stageCounts(groupByStage(filtered, STAGES), STAGES).all ?? 0;
    expect(count).toBe(1);
  });
});
