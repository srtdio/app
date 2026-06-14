import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';

vi.mock('@/lib/events', () => ({ dispatchSorted: vi.fn() }));

// Only the proc call is mocked; the transition map, types, and reads stay real.
vi.mock('@srtdio/posts', async () => {
  const actual = await vi.importActual<typeof import('@srtdio/posts')>('@srtdio/posts');
  return { ...actual, stageTransition: vi.fn() };
});

import {
  moveErrorMessage,
  pipelineHeader,
  postCountLabel,
  runMovePost,
  stageCounts,
} from '@/components/pages/PipelinePage';
import type { MovePostDeps } from '@/components/pages/PipelinePage';
import { dispatchSorted } from '@/lib/events';
import { STAGE_TRANSITIONS, stageTransition } from '@srtdio/posts';
import type { Client, PipelinePost, Result, Stage } from '@srtdio/posts';
import { groupByStage } from '@/lib/post-board';
import { filterByTitle, sortByDate } from '@/lib/list-sort';
import { SectionHeader } from '@/components/shell/SectionHeader';
import { SortMenu } from '@/components/ui/SortMenu';
import { Tabs } from '@/components/shell/Tabs';

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
// while leaving stateful children (SortMenu, Tabs) as unexpanded elements.
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
    sort: 'newest',
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

  it('keeps the stage tabs in the filter slot', () => {
    const tabs = findAll(header(), (el) => el.type === Tabs);
    expect(tabs).toHaveLength(1);
    const items = (tabs[0]!.props as { items: { key: string; label: string }[] }).items;
    expect(items.map((t) => t.key)).toContain('all');
    // The label carries the count as a trailing badge, e.g. "All 3".
    expect(items.find((t) => t.key === 'all')?.label).toBe('All 3');
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
