import { afterEach, describe, expect, it, vi } from 'vitest';
// ActionMenu picks popover vs Sheet by width; the node env has no matchMedia.
vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => true,
}));
import { IconButton } from '@/components/ui/IconButton';
import type { ReactElement, ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

vi.mock('@/lib/events', () => ({ dispatchSorted: vi.fn() }));

// Only the proc call is mocked; the transition map, types, and reads stay real.
vi.mock('@srtdio/posts', async () => {
  const actual = await vi.importActual<typeof import('@srtdio/posts')>('@srtdio/posts');
  return { ...actual, stageTransition: vi.fn() };
});

// The unit env is `node` with no DOM. PipelineSortControl is the only component
// here invoked as a plain function (every other surface is a pure helper or an
// unexpanded element node), so we mock the two hooks it touches: useIsLaptop is
// stubbed to a fixed breakpoint, and useState is a pure shim that records its
// setters per call index (0 = sheet/popover open, 1 = calendar open) so a test
// can force initial state and observe a setter firing without a renderer.

const hookState = vi.hoisted(() => ({
  index: 0,
  overrides: {} as Record<number, unknown>,
  calls: [] as unknown[][],
  // The resolved initializer of each useState call, by call index. Lets a test
  // observe a component's default state without a renderer (see the Review-chip
  // default guard below).
  inits: [] as unknown[],
  reset(): void {
    this.index = 0;
    this.overrides = {};
    this.calls = [];
    this.inits = [];
  },
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: (init: unknown) => {
      const i = hookState.index;
      const base = typeof init === 'function' ? (init as () => unknown)() : init;
      hookState.inits[i] = base;
      const value = i in hookState.overrides ? hookState.overrides[i] : base;
      const setter = (next: unknown): void => {
        hookState.calls[i] = (hookState.calls[i] ?? []).concat([next]);
      };
      hookState.index += 1;
      return [value, setter];
    },
  };
});

// The page reads workspace + navigation on render; both are stubbed so the page
// body can be invoked far enough to run its first useState (the stage filter).
vi.mock('react-router-dom', () => ({
  useNavigate: () => () => {},
  useSearchParams: () => [new URLSearchParams(), () => {}],
}));
vi.mock('@/lib/session-context', () => ({ useSession: () => ({ session: null }) }));
vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: null, workspaces: [] }),
}));

import {
  INITIAL_STAGE,
  MOVE_FALLBACK_MESSAGE,
  boardStages,
  filteredEmpty,
  moveErrorMessage,
  pipelineHeader,
  pipelineSurface,
  postCountLabel,
  postsSkeleton,
  runUndoableMove,
  skeletonRatio,
  undoMoveLabel,
  sanitizePostSort,
  stageCounts,
  visibleStage,
} from '@/components/pages/PipelinePage';
import type { MovePostDeps, UndoableMoveDeps } from '@/components/pages/PipelinePage';
import { renderToStaticMarkup } from 'react-dom/server';
import { parsePipelineQuery } from '@/components/pages/pipeline/pipeline-query';
import type { UndoableAction } from '@/lib/use-undoable-action';
import { NoResults } from '@/components/ui/NoResults';
import { PipelineBoard } from '@/components/pages/pipeline/PipelineBoard';
import { PipelineFeed } from '@/components/pages/pipeline/PipelineFeed';
import type { PresignCache } from '@/lib/asset-presign';
import {
  PipelineDateControl,
  PipelineFilterControl,
  PipelineSortControl,
  customRangeLabel,
  dateControlBody,
  dateFilterActive,
  filterControlBody,
  sortControlBody,
} from '@/components/pages/pipeline/PipelineSortControl';
import { IconFilterLines, IconSort } from '@/components/ui/icons';
import { BoardColumns } from '@/components/pages/pipeline/board-columns';
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
import { IconPlus } from '@/components/ui/icons';
import { INDUCTION_KEYS } from '@/lib/induction';
import { SortMenu } from '@/components/ui/SortMenu';
import { StageChips } from '@/components/pages/pipeline/StageChips';
import type { StageChipItem } from '@/components/pages/pipeline/StageChips';

const STAGES = Object.keys(STAGE_TRANSITIONS) as Stage[];
const stMock = vi.mocked(stageTransition);

function makePost(id: string, stage: Stage): PipelinePost {
  return {
    id,
    workspace_id: 'w',
    number: 1,
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
    approved_by: null,
    approved_on_behalf_of: null,
    approved_at: null,
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
    role: 'agency',
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

/** The labelled New post button: its last child is the label, the plus icon leads. */
function isNewPost(el: ReactElement): boolean {
  const children = (el.props as { children?: ReactNode }).children;
  return Array.isArray(children) && children[children.length - 1] === 'New post';
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

function header(canCreate = true): ReactElement {
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
    canCreate,
  });
}

describe('pipelineHeader', () => {
  it('uses the shared SectionHeader with the one combined filter control (no raw SortMenu)', () => {
    const tree = header();
    expect(findAll(tree, (el) => el.type === SectionHeader)).toHaveLength(1);
    expect(findAll(tree, (el) => el.type === SortMenu)).toHaveLength(0);
    expect(findAll(tree, (el) => el.type === PipelineFilterControl)).toHaveLength(1);
    // The two standalone buttons are gone from the row.
    expect(findAll(tree, (el) => el.type === PipelineSortControl)).toHaveLength(0);
    expect(findAll(tree, (el) => el.type === PipelineDateControl)).toHaveLength(0);
  });

  it('passes the sort to SectionHeader as a { node } that IS the combined control', () => {
    const headers = findAll(header(), (el) => el.type === SectionHeader);
    expect(headers).toHaveLength(1);
    const sort = (headers[0]!.props as { sort: { node?: ReactElement } }).sort;
    expect(sort.node).toBeDefined();
    expect(sort.node!.type).toBe(PipelineFilterControl);
  });

  it('wires the active order and the date-window state to the combined control', () => {
    const controls = findAll(header(), (el) => el.type === PipelineFilterControl);
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

  it('is one row on every screen: no phone wrap class, search shrinks, New post never wraps', () => {
    const tree = header();
    const props = tree.props as { className?: string; 'data-pipeline-toolbar'?: string };
    expect(tree.type).toBe('div');
    expect(props['data-pipeline-toolbar']).toBe('');
    expect(props.className).toBeUndefined();
    const newPost = findAll(tree, isNewPost)[0]!;
    const cls = (newPost.props as { className: string }).className;
    expect(cls).toContain('shrink-0');
    expect(cls).toContain('whitespace-nowrap');
    expect(cls).not.toContain('max-md:');
    // Labelled, with the plus icon leading: never an icon-only button.
    const children = (newPost.props as { children: ReactNode[] }).children;
    expect(children).toHaveLength(2);
    expect((children[0] as ReactElement).type).toBe(IconPlus);
    expect(children[1]).toBe('New post');
    // The search is still the one SectionHeader field, first in its row.
    const section = findAll(tree, (el) => el.type === SectionHeader)[0]!;
    expect((section.props as { search: { placeholder: string } }).search.placeholder).toBe(
      'Search posts',
    );
  });

  it('dispatches sorted:create-post from the New post action', () => {
    const button = findAll(header(), isNewPost);
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

describe('opens on the Review chip by default', () => {
  it('initializes the stage filter to review, the stages in order and All closing the row (no Plan chip)', () => {
    // (a) A query naming no stage (the stage lives in the URL now) opens on 'review'.
    const initial = parsePipelineQuery(new URLSearchParams(), INITIAL_STAGE).stage;
    expect(initial).toBe('review');

    // (b) The chip order is the stages in transition-map order, then All;
    // the review default only shifts which chip is selected, never the list.
    const chips = findAll(
      pipelineHeader({
        search: '',
        onSearchChange: () => {},
        sort: 'updated',
        onSortChange: () => {},
        dateWindow: 'any',
        onDateWindowChange: () => {},
        customRange: null,
        onCustomRangeChange: () => {},
        weekStartDay: 1,
        stage: initial,
        onStageChange: () => {},
        counts: { all: 3, draft: 2, review: 1 },
        canCreate: true,
      }),
      (el) => el.type === StageChips,
    );
    expect(chips).toHaveLength(1);
    const props = chips[0]!.props as { active: string; items: StageChipItem[] };
    expect(props.active).toBe('review');
    expect(props.items[props.items.length - 1]!.key).toBe('all');
    expect(props.items.map((t) => t.key)).toEqual([...STAGES, 'all']);
    expect(props.items.some((t) => t.key === 'plan' || t.label === 'Plan')).toBe(false);
  });

  it('a stale ?view=plan link opens Review: the page never reads view or week', () => {
    expect(INITIAL_STAGE).toBe('review');
    const src = readFileSync(fileURLToPath(new URL('./PipelinePage.tsx', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/PlanWeek|SetDateSheet|['"]week['"]|['"]view['"]/);
    // A stale ?view=plan link still opens Review: only the pipeline keys are read.
    expect(
      parsePipelineQuery(new URLSearchParams('view=plan&week=2026-06-15'), INITIAL_STAGE),
    ).toEqual({ stage: 'review', search: '', dateWindow: 'any', customRange: null });
  });
});

describe('the surface', () => {
  function surface(stage: string, isDesktop: boolean): ReactElement {
    return pipelineSurface({
      role: 'agency',
      stage,
      isDesktop,
      sorted: [],
      grouped: groupByStage([], STAGES),
      // The tree is walked and no card is ever expanded, so the cache is untouched.
      cache: {} as unknown as PresignCache,
      presignEnabled: false,
      workspaceKey: null,
      onViewAll: () => {},
      onMovePost: () => {},
      onLongPressPost: () => {},
      onBlockedMove: () => {},
      shownKey: 'pipeline:shown:',
    });
  }

  it('is the board on desktop and the feed on a phone for every chip (no Plan week)', () => {
    for (const stage of [...STAGES, 'all', 'plan']) {
      expect(findAll(surface(stage, true), (el) => el.type === PipelineBoard)).toHaveLength(1);
      expect(findAll(surface(stage, false), (el) => el.type === PipelineFeed)).toHaveLength(1);
    }
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
  it('maps every proc code to the one plain line without leaking the raw code', () => {
    for (const code of ['invalid_stage_transition', 'unknown'] as const) {
      expect(moveErrorMessage(code)).toBe("Couldn't move the post. Try again.");
      expect(moveErrorMessage(code)).not.toContain(code);
    }
    for (const code of ['forbidden_role', 'workspace_member_only'] as const) {
      expect(moveErrorMessage(code)).toBe(
        "Couldn't move the post. You don't have access to do this.",
      );
      expect(moveErrorMessage(code)).not.toContain(code);
    }
  });
});

describe('every move: flip, "Moved to {Stage}" with Undo, then send', () => {
  afterEach(() => {
    stMock.mockReset();
  });

  /** The harness deps plus a captured Undo runner. */
  function undoable(posts: PipelinePost[], over: Partial<UndoableMoveDeps> = {}) {
    const h = harness(posts);
    const actions: UndoableAction[] = [];
    const deps: UndoableMoveDeps = { ...h.deps, run: (a) => actions.push(a), ...over };
    return { h, deps, actions };
  }

  it('success: flips at once, closes, toasts "Moved to Review" with Undo, and sends once on expiry', async () => {
    stMock.mockResolvedValue({ ok: true, data: 'ok' } satisfies Result<string>);
    const { h, deps, actions } = undoable([makePost('p1', 'draft')]);

    runUndoableMove(deps, 'p1', 'review');

    // The post re-groups into the new stage column before anything is sent.
    const grouped = groupByStage(h.state(), STAGES);
    expect(grouped.review.map((p) => p.id)).toEqual(['p1']);
    expect(grouped.draft).toHaveLength(0);
    expect(h.closed()).toBe(true);
    expect(actions.map((a) => a.label)).toEqual(['Moved to Review']);
    expect(stMock).not.toHaveBeenCalled();
    await actions[0]!.commit();
    expect(stMock).toHaveBeenCalledTimes(1);
    expect(stMock).toHaveBeenCalledWith(h.deps.client, { postId: 'p1', toStage: 'review' });
    // No title in quotes anywhere.
    expect(h.toasts).toEqual([]);
  });

  it('the toast reads "Moved to {Stage}" for every target, no title', () => {
    for (const stage of STAGES)
      expect(undoMoveLabel(stage)).toBe(`Moved to ${stage[0]!.toUpperCase()}${stage.slice(1)}`);
    expect(undoMoveLabel('approved')).toBe('Moved to Approved');
    for (const [from, to] of [
      ['draft', 'review'],
      ['review', 'approved'],
      ['review', 'parked'],
      ['approved', 'rejected'],
      ['rejected', 'review'],
    ] as [Stage, Stage][]) {
      const { deps, actions } = undoable([makePost('p1', from)]);
      runUndoableMove(deps, 'p1', to);
      expect(actions.map((a) => a.label)).toEqual([undoMoveLabel(to)]);
      expect(actions[0]!.label).not.toContain('Post p1');
      expect(actions[0]!.label).not.toContain('"');
    }
  });

  it('an on-behalf approve sends the picked approver with the move', async () => {
    stMock.mockResolvedValue({ ok: true, data: 'ok' } satisfies Result<string>);
    const { h, deps, actions } = undoable([makePost('p1', 'review')]);
    runUndoableMove(deps, 'p1', 'approved', null, { onBehalfOf: 'u-client' });
    expect(h.state()[0]!.stage).toBe('approved');
    await actions[0]!.commit();
    expect(stMock).toHaveBeenCalledWith(h.deps.client, {
      postId: 'p1',
      toStage: 'approved',
      onBehalfOf: 'u-client',
    });
  });

  it('an approver is never sent for a move other than approve', async () => {
    stMock.mockResolvedValue({ ok: true, data: 'ok' } satisfies Result<string>);
    const { h, deps, actions } = undoable([makePost('p1', 'review')]);
    runUndoableMove(deps, 'p1', 'parked', null, { onBehalfOf: 'u-client' });
    await actions[0]!.commit();
    expect(stMock).toHaveBeenCalledWith(h.deps.client, { postId: 'p1', toStage: 'parked' });
  });

  it('client role: a park or back-to-review never flips or reaches the proc', () => {
    for (const [from, to] of [
      ['review', 'parked'],
      ['approved', 'parked'],
      ['rejected', 'review'],
    ] as [Stage, Stage][]) {
      const { h, deps, actions } = undoable([makePost('p1', from)], { role: 'client' });
      runUndoableMove(deps, 'p1', to);
      expect(h.setPostsCalls()).toBe(0);
      expect(actions).toHaveLength(0);
    }
    expect(stMock).not.toHaveBeenCalled();
  });

  it('client role: approve and reject still go through', () => {
    for (const to of ['approved', 'rejected'] as const) {
      const { h, deps, actions } = undoable([makePost('p1', 'review')], { role: 'client' });
      runUndoableMove(deps, 'p1', to);
      expect(h.state()[0]!.stage).toBe(to);
      expect(actions).toHaveLength(1);
    }
  });

  it('failure: puts the post back and toasts a friendly error', async () => {
    stMock.mockResolvedValue({
      ok: false,
      error: { code: 'invalid_stage_transition', message: 'invalid_stage_transition' },
    } satisfies Result<string>);
    const { h, deps, actions } = undoable([makePost('p1', 'review')]);
    runUndoableMove(deps, 'p1', 'approved');
    await actions[0]!.commit();
    expect(h.state()[0]!.stage).toBe('review');
    expect(h.toasts).toEqual([moveErrorMessage('invalid_stage_transition')]);
    expect(h.deps.inFlight.has('p1')).toBe(false);
  });

  it('transport failure: a thrown proc toasts the fallback error and clears the in-flight guard', async () => {
    stMock.mockRejectedValue(new Error('network down'));
    const { h, deps, actions } = undoable([makePost('p1', 'draft')]);
    runUndoableMove(deps, 'p1', 'review');
    await actions[0]!.commit();
    expect(h.state()[0]!.stage).toBe('draft');
    expect(h.toasts).toEqual([MOVE_FALLBACK_MESSAGE]);
    expect(h.deps.inFlight.has('p1')).toBe(false);
  });

  it('offline: a fetch failure toasts "Couldn\'t move the post. You\'re offline." with Retry', async () => {
    stMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const failures: Array<{ message: string; retry: boolean }> = [];
    const { deps, actions } = undoable([makePost('p1', 'draft')], {
      toast: (message, failure) => failures.push({ message, retry: failure?.retry !== undefined }),
    });
    runUndoableMove(deps, 'p1', 'review');
    await actions[0]!.commit();
    expect(failures).toEqual([{ message: "Couldn't move the post. Try again.", retry: true }]);
  });

  it('a refusal toasts as a failure with no Retry', async () => {
    stMock.mockResolvedValue({
      ok: false,
      error: { code: 'forbidden_role', message: 'forbidden_role' },
    } satisfies Result<string>);
    const failures: Array<{ message: string; failed: boolean; retry: boolean }> = [];
    const { deps, actions } = undoable([makePost('p1', 'draft')], {
      toast: (message, failure) =>
        failures.push({
          message,
          failed: failure !== undefined,
          retry: failure?.retry !== undefined,
        }),
    });
    runUndoableMove(deps, 'p1', 'review');
    await actions[0]!.commit();
    expect(failures).toEqual([
      {
        message: "Couldn't move the post. You don't have access to do this.",
        failed: true,
        retry: false,
      },
    ]);
  });

  it('double-fire guard: two rapid calls for the same post flip and queue once', () => {
    const { deps, actions } = undoable([makePost('p1', 'draft')]);
    runUndoableMove(deps, 'p1', 'review');
    runUndoableMove(deps, 'p1', 'review');
    expect(actions).toHaveLength(1);
  });
});

describe('persisted sort sanitization (fix 1)', () => {
  it('heals a stale stored value the trimmed menu no longer lists', () => {
    // Live workspaces stored 'newest'/'title' before the trim.
    expect(sanitizePostSort('newest')).toBe(POST_SORT_DEFAULT);
    expect(sanitizePostSort('title')).toBe(POST_SORT_DEFAULT);
    expect(sanitizePostSort('')).toBe(POST_SORT_DEFAULT);
  });

  it('passes a still-listed value through untouched', () => {
    expect(sanitizePostSort('updated')).toBe('updated');
    // 'oldest' is listed again ("Oldest first").
    expect(sanitizePostSort('oldest')).toBe('oldest');
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
      canCreate: true,
    });
    const controls = findAll(tree, (el) => el.type === PipelineFilterControl);
    expect((controls[0]!.props as { order: string }).order).toBe(POST_SORT_DEFAULT);
  });
});

interface ShellParts {
  trigger: ReactElement;
  body: ReactElement;
  extra?: ReactNode;
}

describe('PipelineSortControl and PipelineDateControl (two buttons)', () => {
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
  function menuRows(tree: ReactNode): ReactElement[] {
    return findAll(tree, (el) => (el.props as { role?: string }).role === 'menuitemradio');
  }
  function body(over: Partial<Parameters<typeof sortControlBody>[0]> = {}): ReactElement {
    return sortControlBody({ order: 'updated', onOrderChange: () => {}, ...over });
  }
  function dateBody(over: Partial<Parameters<typeof dateControlBody>[0]> = {}): ReactElement {
    return dateControlBody({
      dateWindow: 'any',
      onDateWindowChange: () => {},
      customRange: null,
      onCustomOpen: () => {},
      ...over,
    });
  }
  /** The shell's parts: the controls render MenuShell, which holds them as props. */
  function shell(tree: ReactElement): ShellParts {
    return tree.props as ShellParts;
  }
  function dateControl(over: Partial<Parameters<typeof PipelineDateControl>[0]> = {}) {
    return PipelineDateControl({
      dateWindow: 'any',
      onDateWindowChange: () => {},
      customRange: null,
      onCustomRangeChange: () => {},
      weekStartDay: 1,
      ...over,
    });
  }

  it('Sort holds only the order: no groups, no date rows', () => {
    const groups = findAll(body(), (el) => (el.props as { role?: string }).role === 'group');
    expect(groups).toEqual([]);
    expect(menuRows(body()).map(rowLabel)).not.toContain('This week');
  });

  it('Sort lists Newest first, Oldest first and Due date and fires onOrderChange', () => {
    let picked: string | null = null;
    const rows = menuRows(
      body({
        onOrderChange: (o) => {
          picked = o;
        },
      }),
    );
    expect(rows.map(rowLabel)).toEqual(['Newest first', 'Oldest first', 'Due date']);
    (rows[1]!.props as { onClick: () => void }).onClick();
    expect(picked).toBe('oldest');
    (rows[2]!.props as { onClick: () => void }).onClick();
    expect(picked).toBe('target');
  });

  it('the date filter lists Any time/This week/This month plus a Custom row', () => {
    expect(menuRows(dateBody()).map(rowLabel)).toEqual([
      'Any time',
      'This week',
      'This month',
      'Custom…',
    ]);
  });

  it('fires onDateWindowChange from a preset row', () => {
    let picked: string | null = null;
    const rows = menuRows(
      dateBody({
        onDateWindowChange: (w) => {
          picked = w;
        },
      }),
    );
    const week = rows.find((r) => rowLabel(r) === 'This week')!;
    (week.props as { onClick: () => void }).onClick();
    expect(picked).toBe('week');
  });

  it('labels the Custom row from the active range', () => {
    expect(customRangeLabel(null)).toBe('Custom…');
    expect(customRangeLabel({ start: '2026-06-24', end: '2026-06-24' })).toBe('24 Jun');
    expect(customRangeLabel({ start: '2026-06-24', end: '2026-06-27' })).toBe('24 Jun to 27 Jun');
  });

  it('tapping the Custom row opens the calendar (flips the calendar-open state)', () => {
    hookState.reset();
    hookState.overrides[0] = true; // force the popover open so the body renders
    const tree = dateControl();
    const custom = menuRows(shell(tree).body).find((r) => rowLabel(r) === 'Custom…')!;
    (custom.props as { onClick: () => void }).onClick();
    // index 1 is the calendar-open useState; tapping Custom sets it true.
    expect(hookState.calls[1]).toEqual([true]);
  });

  it('picking an order or a preset closes its own menu', () => {
    hookState.reset();
    let order: string | null = null;
    const sortTree = PipelineSortControl({
      order: 'updated',
      onOrderChange: (o) => {
        order = o;
      },
    });
    const oldest = menuRows(shell(sortTree).body).find((r) => rowLabel(r) === 'Oldest first')!;
    (oldest.props as { onClick: () => void }).onClick();
    expect(order).toBe('oldest');
    expect(hookState.calls[0]).toEqual([false]);
    hookState.reset();
    const week = menuRows(shell(dateControl()).body).find((r) => rowLabel(r) === 'This week')!;
    (week.props as { onClick: () => void }).onClick();
    expect(hookState.calls[0]).toEqual([false]);
  });

  it('applying a range fires onCustomRangeChange and switches the window to custom', () => {
    hookState.reset();
    hookState.overrides[1] = true; // calendar open
    let range: { start: string; end: string } | null = null;
    let chosen: string | null = null;
    const tree = dateControl({
      onDateWindowChange: (w) => {
        chosen = w;
      },
      onCustomRangeChange: (r) => {
        range = r;
      },
    });
    const calendars = findAll(shell(tree).extra, (el) => el.type === PipelineDateRangeCalendar);
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

  it('W4 fix 9: applying a custom range closes the date sheet too, not just the calendar', () => {
    hookState.reset();
    hookState.overrides[0] = true; // sheet/popover open
    hookState.overrides[1] = true; // calendar open
    const tree = dateControl();
    const calendar = findAll(shell(tree).extra, (el) => el.type === PipelineDateRangeCalendar)[0]!;
    const cal = calendar.props as { onApply: (r: { start: string; end: string }) => void };
    cal.onApply({ start: '2026-06-24', end: '2026-06-27' });
    expect(hookState.calls[1]).toEqual([false]);
    expect(hookState.calls[0]).toEqual([false]);
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

describe('W4 fix 3: create gating', () => {
  it('hides the New post button unless post.create is granted', () => {
    expect(findAll(header(false), isNewPost)).toHaveLength(0);
    expect(findAll(header(true), isNewPost)).toHaveLength(1);
  });

  it('shows New post as visible text, not an icon-only button', () => {
    const button = findAll(header(true), isNewPost)[0]!;
    const props = button.props as {
      'aria-label'?: string;
      'data-induction'?: string;
      className?: string;
    };
    expect(props['aria-label']).toBeUndefined();
    expect(props['data-induction']).toBe(INDUCTION_KEYS.pipelineCreate);
    expect(props.className).toContain('whitespace-nowrap');
    // The plus icon leads the label; the button is never icon-only.
    expect(findAll(button, (el) => el.type === IconPlus)).toHaveLength(1);
    expect(
      findAll(
        header(true),
        (el) => (el.props as { 'aria-label'?: string })['aria-label'] === 'Create post',
      ),
    ).toHaveLength(0);
  });
});

describe('W4 fix 4: filtered empty state', () => {
  it('renders the shared NoResults with the search and date filter, wired to the reset', () => {
    const onClear = vi.fn();
    const tree = filteredEmpty('launch', true, onClear);
    const empty = findAll(tree, (el) => el.type === NoResults)[0]!;
    const props = empty.props as { query: string; filtersActive: boolean; onClear: () => void };
    expect(props.query).toBe('launch');
    expect(props.filtersActive).toBe(true);
    props.onClear();
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});

describe('W4 fix 6 (revised): the date filter is its own button, no chip under the header', () => {
  it('the page no longer renders a date chip with a Clear date filter X', () => {
    const src = readFileSync(fileURLToPath(new URL('./PipelinePage.tsx', import.meta.url)), 'utf8');
    expect(src).not.toContain('dateFilterChip');
    expect(src).not.toContain('Clear date filter');
    expect(src).toContain('PipelineFilterControl');
  });
});

describe('W4 fix 7: undoable moves (Rejected / Parked)', () => {
  afterEach(() => {
    stMock.mockReset();
  });

  function undoHarness(stage: Stage): {
    h: ReturnType<typeof harness>;
    actions: UndoableAction[];
  } {
    const h = harness([makePost('p1', stage)]);
    const actions: UndoableAction[] = [];
    return { h, actions };
  }

  it('Rejected and Parked carry the "Moved to X" label', () => {
    expect(undoMoveLabel('rejected')).toBe('Moved to Rejected');
    expect(undoMoveLabel('parked')).toBe('Moved to Parked');
  });

  it('flips at once, sends nothing until the window ends, then sends once', async () => {
    stMock.mockResolvedValue({ ok: true, data: 'ok' } satisfies Result<string>);
    const { h, actions } = undoHarness('review');
    runUndoableMove({ ...h.deps, run: (a) => actions.push(a) }, 'p1', 'rejected');
    expect(h.state()[0]!.stage).toBe('rejected');
    expect(h.closed()).toBe(true);
    expect(actions.map((a) => a.label)).toEqual(['Moved to Rejected']);
    expect(stMock).not.toHaveBeenCalled();
    await actions[0]!.commit();
    expect(stMock).toHaveBeenCalledTimes(1);
    expect(stMock).toHaveBeenCalledWith(h.deps.client, { postId: 'p1', toStage: 'rejected' });
    expect(h.deps.inFlight.has('p1')).toBe(false);
  });

  it('Undo puts the post back and the proc is never sent', () => {
    const { h, actions } = undoHarness('approved');
    runUndoableMove({ ...h.deps, run: (a) => actions.push(a) }, 'p1', 'parked');
    expect(h.state()[0]!.stage).toBe('parked');
    actions[0]!.revert?.();
    expect(h.state()[0]!.stage).toBe('approved');
    expect(stMock).not.toHaveBeenCalled();
    expect(h.deps.inFlight.has('p1')).toBe(false);
  });

  it('a failed send puts the post back and toasts the friendly error', async () => {
    stMock.mockResolvedValue({
      ok: false,
      error: { code: 'forbidden_role', message: 'forbidden_role' },
    } satisfies Result<string>);
    const { h, actions } = undoHarness('review');
    runUndoableMove({ ...h.deps, run: (a) => actions.push(a) }, 'p1', 'rejected');
    await actions[0]!.commit();
    expect(h.state()[0]!.stage).toBe('review');
    expect(h.toasts).toEqual([moveErrorMessage('forbidden_role')]);
  });

  it('an illegal move never flips (draft cannot go to Rejected)', () => {
    const { h, actions } = undoHarness('draft');
    runUndoableMove({ ...h.deps, run: (a) => actions.push(a) }, 'p1', 'rejected');
    expect(h.setPostsCalls()).toBe(0);
    expect(actions).toHaveLength(0);
  });

  it('the page no longer imports the assets toasts', () => {
    const src = readFileSync(fileURLToPath(new URL('./PipelinePage.tsx', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/assets\/useToasts|assets\/Toasts/);
    expect(src).toMatch(/@\/components\/ui\/toast/);
    expect(src).toMatch(/useUndoableAction/);
  });
});

describe('E: clients never see Draft', () => {
  it('the laptop board has no Draft column for a client; the agency side keeps it', () => {
    expect(boardStages('all', 'client')).toEqual(['review', 'approved', 'parked', 'rejected']);
    expect(boardStages('all', 'agency')).toEqual(STAGES);
    expect(boardStages('all', 'owner')).toContain('draft');
    expect(boardStages('draft', 'client')).toEqual([]);
    expect(boardStages('review', 'client')).toEqual(['review']);
  });

  it('a client on a Draft link lands on Review', () => {
    expect(visibleStage('draft', 'client')).toBe('review');
    expect(visibleStage('draft', 'agency')).toBe('draft');
    expect(visibleStage('all', 'client')).toBe('all');
  });

  it('the surface hands the board the client columns', () => {
    const tree = pipelineSurface({
      role: 'client',
      stage: 'all',
      isDesktop: true,
      sorted: [],
      grouped: groupByStage([], STAGES),
      cache: {} as unknown as PresignCache,
      presignEnabled: false,
      workspaceKey: null,
      onViewAll: () => {},
      onMovePost: () => {},
      onLongPressPost: () => {},
      onBlockedMove: () => {},
      shownKey: 'pipeline:shown:',
      roleReady: false,
    });
    const props = tree.props as { stages: Stage[]; roleReady: boolean };
    expect(props.stages).not.toContain('draft');
    expect(props.roleReady).toBe(false);
  });
});

describe('E: no jumps while loading', () => {
  it('the New post space is held while post.create is still loading', () => {
    const tree = pipelineHeader({
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
      counts: { all: 0 },
      canCreate: false,
      createPending: true,
    });
    const held = findAll(tree, isNewPost);
    expect(held).toHaveLength(1);
    const props = held[0]!.props as {
      className: string;
      'aria-hidden'?: string;
      tabIndex?: number;
      disabled?: boolean;
      onClick?: unknown;
    };
    expect(props.className).toContain('invisible');
    expect(props['aria-hidden']).toBe('true');
    expect(props.tabIndex).toBe(-1);
    expect(props.disabled).toBe(true);
    expect(props.onClick).toBeUndefined();
  });

  it('the laptop All skeleton is the kanban, one column per stage, cards in the platform frame', () => {
    const ratio = skeletonRatio('instagram');
    expect(ratio).toBeCloseTo(0.8);
    expect(skeletonRatio(null)).toBeNull();
    const kanban = renderToStaticMarkup(postsSkeleton(true, { kanban: true, ratio, columns: 5 }));
    expect(kanban).toContain('data-posts-skeleton="kanban"');
    expect((kanban.match(/w-\[260px\]/g) ?? []).length).toBe(5);
    expect(kanban).toContain('aspect-ratio:0.8');
    expect(kanban).not.toContain('aspect-square');
    // The card shape: full height, a two-line title block and the meta row.
    expect(kanban).toContain('min-h-[2.75em]');
    expect(kanban).toContain('h-5');
    const client = renderToStaticMarkup(postsSkeleton(true, { kanban: true, ratio, columns: 4 }));
    expect((client.match(/w-\[260px\]/g) ?? []).length).toBe(4);
    // A stage view on a laptop draws the same column stacks as the cards.
    const stacks = postsSkeleton(true, { ratio });
    expect(stacks.type).toBe(BoardColumns);
    const grid = renderToStaticMarkup(stacks);
    expect(grid).toContain('flex items-start gap-4');
    expect(grid).toContain('data-board-column=""');
    expect(grid).toContain('flex min-w-0 flex-1 flex-col gap-4');
    expect(grid).not.toContain('grid-cols-[repeat(auto-fill,minmax(220px,1fr))]');
    expect(grid).toContain('<span class="sr-only">Loading posts</span>');
  });
});

describe('PipelineFilterControl: one icon button, one sheet holding due date and sort', () => {
  function rowLabel(button: ReactElement): string {
    const all: ReactElement[] = [];
    collect(button, all);
    for (const el of all) {
      const child = (el.props as { children?: ReactNode }).children;
      if (typeof child === 'string') return child;
    }
    return '';
  }
  function menuRows(tree: ReactNode): ReactElement[] {
    return findAll(tree, (el) => (el.props as { role?: string }).role === 'menuitemradio');
  }
  function shell(tree: ReactElement): ShellParts {
    return tree.props as ShellParts;
  }
  function control(over: Partial<Parameters<typeof PipelineFilterControl>[0]> = {}) {
    hookState.reset();
    return PipelineFilterControl({
      order: POST_SORT_DEFAULT,
      onOrderChange: () => {},
      dateWindow: 'any',
      onDateWindowChange: () => {},
      customRange: null,
      onCustomRangeChange: () => {},
      weekStartDay: 1,
      ...over,
    });
  }

  it('the trigger is a single 44x44 icon button labelled Filter and sort, no text', () => {
    const { trigger } = shell(control());
    const props = trigger.props as { label: string; className: string; children: unknown };
    expect(props.label).toBe('Filter and sort');
    // The bare shared IconButton (44x44 by the design system), like SortMenu.
    expect(trigger.type).toBe(IconButton);
    const rendered = IconButton(trigger.props as Parameters<typeof IconButton>[0]);
    expect((rendered.props as { 'aria-label': string })['aria-label']).toBe('Filter and sort');
    expect((rendered.props as { className: string }).className).toContain('h-11 w-11');
    expect(props.className).not.toContain('border');
    expect(props.className).not.toContain('bg-panel');
    expect(props.className).toContain('shrink-0');
    expect(props.className).not.toMatch(/(^|\s|:)!/);
    expect(findAll(trigger, (el) => el.type === IconSort)).toHaveLength(1);
    expect(findAll(trigger, (el) => el.type === IconFilterLines)).toHaveLength(0);
    expect(texts(trigger)).toEqual([]);
  });

  it('the body holds the due-date rows AND the sort rows, due date first', () => {
    const { body, title } = shell(control()) as ShellParts & { title: string };
    expect(title).toBe('Filter and sort');
    const labels = menuRows(body).map(rowLabel);
    expect(labels).toContain('This week');
    expect(labels).toContain('Custom…');
    expect(labels).toContain('Newest first');
    expect(labels).toContain('Due date');
    expect(labels.indexOf('Custom…')).toBeLessThan(labels.indexOf('Newest first'));
    const menus = findAll(body, (el) => (el.props as { role?: string }).role === 'menu').map(
      (el) => (el.props as { 'aria-label': string })['aria-label'],
    );
    expect(menus).toEqual(['Due date', 'Sort']);
  });

  it('a sort pick fires onOrderChange and closes; a date pick fires onDateWindowChange and closes', () => {
    const onOrderChange = vi.fn();
    const onDateWindowChange = vi.fn();
    const { body } = shell(control({ onOrderChange, onDateWindowChange }));
    const rows = menuRows(body);
    const oldest = rows.find((r) => rowLabel(r) === 'Oldest first')!;
    (oldest.props as { onClick: () => void }).onClick();
    expect(onOrderChange).toHaveBeenCalledWith('oldest');
    const week = rows.find((r) => rowLabel(r) === 'This week')!;
    (week.props as { onClick: () => void }).onClick();
    expect(onDateWindowChange).toHaveBeenCalledWith('week');
    // useState index 0 is `open`: both picks set it false.
    expect(hookState.calls[0]).toEqual([false, false]);
  });

  it('the Custom row still opens the floating range calendar, mounted as the shell extra', () => {
    const parts = shell(control());
    const calendars = findAll(parts.extra, (el) => el.type === PipelineDateRangeCalendar);
    expect(calendars).toHaveLength(1);
    const custom = menuRows(parts.body).find((r) => rowLabel(r) === 'Custom…')!;
    (custom.props as { onClick: () => void }).onClick();
    // useState index 1 is `calendarOpen`.
    expect(hookState.calls[1]).toEqual([true]);
  });

  it('shows the corner dot only while a date window or a non-default sort is on', () => {
    const dot = (tree: ReactElement) =>
      findAll(shell(tree).trigger, (el) => 'data-filter-dot' in (el.props as object));
    expect(dot(control())).toHaveLength(0);
    expect(dot(control({ dateWindow: 'week' }))).toHaveLength(1);
    expect(dot(control({ order: 'oldest' }))).toHaveLength(1);
    // Custom with no range applied is not a filter.
    expect(dot(control({ dateWindow: 'custom', customRange: null }))).toHaveLength(0);
    expect(dateFilterActive('custom', { start: '2026-06-24', end: '2026-06-27' })).toBe(true);
    const trigger = shell(control({ order: 'target' })).trigger;
    expect((trigger.props as { 'data-active'?: string })['data-active']).toBe('');
  });

  it('filterControlBody is pure: both sections render from the same props', () => {
    const body = filterControlBody({
      order: 'target',
      onOrderChange: () => {},
      dateWindow: 'month',
      onDateWindowChange: () => {},
      customRange: null,
      onCustomOpen: () => {},
    });
    const checked = menuRows(body)
      .filter((r) => (r.props as { 'aria-checked': boolean })['aria-checked'])
      .map(rowLabel);
    expect(checked).toEqual(['This month', 'Due date']);
  });
});
