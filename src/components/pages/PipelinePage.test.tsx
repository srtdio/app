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
import { filterByTitle, filterByWindow, sortByDate, type DateWindow } from '@/lib/list-sort';
import { SectionHeader } from '@/components/shell/SectionHeader';
import { SortMenu, type SortOption } from '@/components/ui/SortMenu';
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

  it('offers exactly the two trimmed sort options', () => {
    const headers = findAll(header(), (el) => el.type === SectionHeader);
    expect(headers).toHaveLength(1);
    const options = (headers[0]!.props as { sort: { options: SortOption[] } }).sort.options;
    expect(options.map((o) => o.value)).toEqual(['updated', 'target']);
    expect(options.map((o) => o.label)).toEqual(['Recently updated', 'Target date']);
  });

  it('forwards the (already sanitized) active sort to the header', () => {
    const headers = findAll(header(), (el) => el.type === SectionHeader);
    expect((headers[0]!.props as { sort: { value: string } }).sort.value).toBe('updated');
  });
});

describe('sanitizePostSort', () => {
  it('passes through a currently-offered option', () => {
    expect(sanitizePostSort('updated')).toBe('updated');
    expect(sanitizePostSort('target')).toBe('target');
  });

  it('heals a stale persisted value to the default', () => {
    // Live workspaces still carry 'newest'/'oldest'/'title' from before the cut.
    expect(sanitizePostSort('newest')).toBe('updated');
    expect(sanitizePostSort('oldest')).toBe('updated');
    expect(sanitizePostSort('title')).toBe('updated');
    expect(sanitizePostSort('')).toBe('updated');
  });
});

describe('PipelineDateWindow', () => {
  function radios(value: DateWindow): ReactElement[] {
    const tree = PipelineDateWindow({ value, onChange: () => {} });
    return findAll(tree, (el) => (el.props as { role?: string }).role === 'radio');
  }

  it('renders the three window options in order', () => {
    const options = radios('any');
    expect(options).toHaveLength(3);
    expect(options.map((el) => (el.props as { children: string }).children)).toEqual([
      'This week',
      'This month',
      'Any time',
    ]);
  });

  it('marks exactly the active option aria-checked', () => {
    const checked = radios('week').filter(
      (el) => (el.props as { 'aria-checked': boolean })['aria-checked'] === true,
    );
    expect(checked).toHaveLength(1);
    expect((checked[0]!.props as { children: string }).children).toBe('This week');
  });

  it('exposes an accessible radiogroup label', () => {
    const tree = PipelineDateWindow({ value: 'any', onChange: () => {} });
    const groups = findAll(tree, (el) => (el.props as { role?: string }).role === 'radiogroup');
    expect(groups).toHaveLength(1);
    expect((groups[0]!.props as { 'aria-label': string })['aria-label']).toBe(
      'Filter by target date',
    );
  });

  it('calls onChange with the picked window, never filtering itself', () => {
    let picked: DateWindow | null = null;
    const tree = PipelineDateWindow({ value: 'any', onChange: (next) => (picked = next) });
    const week = findAll(tree, (el) => el.type === 'button').find(
      (el) => (el.props as { children: string }).children === 'This week',
    );
    (week!.props as { onClick: () => void }).onClick();
    expect(picked).toBe('week');
  });
});

describe('date-window narrowing (page derivation)', () => {
  // Mirror PipelinePage's derivation order: search -> window -> sort -> group ->
  // count. Switching the window must narrow the same counter every surface reads.
  const NOW = new Date('2026-06-24T12:00:00Z'); // Wed; Mon-start week is 06-22..06-28
  function deriveTotal(posts: PipelinePost[], window: DateWindow): number {
    const filtered = filterByWindow(filterByTitle(posts, ''), window, {
      now: NOW,
      timeZone: 'UTC',
      weekStartDay: 1,
    });
    return stageCounts(groupByStage(sortByDate(filtered, 'newest'), STAGES), STAGES).all ?? 0;
  }

  const posts: PipelinePost[] = [
    { ...makePost('1', 'draft'), target_date: '2026-06-24' }, // this week
    { ...makePost('2', 'review'), target_date: '2026-06-10' }, // this month, not week
    { ...makePost('3', 'approved'), target_date: '2026-09-01' }, // far future
    { ...makePost('4', 'parked'), target_date: null }, // no target
  ];

  it("'any' counts every post including the null target_date", () => {
    expect(deriveTotal(posts, 'any')).toBe(4);
  });

  it("'This week' narrows the count to the in-window posts", () => {
    expect(deriveTotal(posts, 'week')).toBe(1);
    expect(deriveTotal(posts, 'week')).toBeLessThan(deriveTotal(posts, 'any'));
  });

  it("'This month' sits between week and any", () => {
    expect(deriveTotal(posts, 'month')).toBe(2);
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
