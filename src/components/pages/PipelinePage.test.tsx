import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';

vi.mock('@/lib/events', () => ({ dispatchSorted: vi.fn() }));

// Only the proc call is mocked; the transition map, types, and reads stay real.
vi.mock('@srtdio/posts', async () => {
  const actual = await vi.importActual<typeof import('@srtdio/posts')>('@srtdio/posts');
  return { ...actual, stageTransition: vi.fn() };
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
import { PipelineDateWindow } from '@/components/pages/pipeline/PipelineDateWindow';
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
    stage: 'all',
    onStageChange: () => {},
    counts: { all: 3, draft: 2, review: 1 },
  });
}

describe('pipelineHeader', () => {
  it('uses the shared SectionHeader with a single real sort control', () => {
    const tree = header();
    expect(findAll(tree, (el) => el.type === SectionHeader)).toHaveLength(1);
    expect(findAll(tree, (el) => el.type === SortMenu)).toHaveLength(1);
  });

  it('offers exactly the two trimmed sort options', () => {
    const menus = findAll(header(), (el) => el.type === SortMenu);
    expect(menus).toHaveLength(1);
    const options = (menus[0]!.props as { options: { value: string; label: string }[] }).options;
    expect(options.map((o) => o.value)).toEqual(['updated', 'target']);
    expect(options.map((o) => o.label)).toEqual(['Recently updated', 'Target date']);
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

  it("the header's active sort is the sanitized default for a stale persisted value", () => {
    // Mirror the page: a stale localStorage value (seed sorted:sort:pipeline =
    // 'newest') is sanitized before it reaches the header's SortMenu.
    const activeSort = sanitizePostSort('newest');
    const tree = pipelineHeader({
      search: '',
      onSearchChange: () => {},
      sort: activeSort,
      onSortChange: () => {},
      stage: 'all',
      onStageChange: () => {},
      counts: { all: 0 },
    });
    const menus = findAll(tree, (el) => el.type === SortMenu);
    expect((menus[0]!.props as { value: string }).value).toBe(POST_SORT_DEFAULT);
  });
});

describe('PipelineDateWindow (fix A)', () => {
  function windowTree(value: DateWindow, onChange: (next: DateWindow) => void): ReactElement {
    return (
      PipelineDateWindow as unknown as (props: {
        value: DateWindow;
        onChange: (next: DateWindow) => void;
      }) => ReactElement
    )({ value, onChange });
  }
  function radios(tree: ReactElement): ReactElement[] {
    return findAll(tree, (el) => (el.props as { role?: string }).role === 'radio');
  }
  function labelOf(el: ReactElement): string {
    return (el.props as { children: string }).children;
  }

  it('renders the three target-date window options as radios', () => {
    const opts = radios(windowTree('any', () => {}));
    expect(opts).toHaveLength(3);
    expect(opts.map(labelOf)).toEqual(['This week', 'This month', 'Any time']);
  });

  it('marks the active option checked and fires onChange on a pick', () => {
    let picked: DateWindow | null = null;
    const opts = radios(
      windowTree('any', (next) => {
        picked = next;
      }),
    );
    const any = opts.find((o) => labelOf(o) === 'Any time')!;
    const week = opts.find((o) => labelOf(o) === 'This week')!;
    expect((any.props as { 'aria-checked': boolean })['aria-checked']).toBe(true);
    expect((week.props as { 'aria-checked': boolean })['aria-checked']).toBe(false);
    (week.props as { onClick: () => void }).onClick();
    expect(picked).toBe('week');
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
});
