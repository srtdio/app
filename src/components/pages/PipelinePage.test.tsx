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
  filteredEmpty,
  moveErrorMessage,
  pipelineHeader,
  pipelineSelectActions,
  pipelineTopbarActions,
  PIPELINE_PLUS_BLOCKED,
  pipelineSurface,
  postCountLabel,
  postsSkeleton,
  runUndoableMove,
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
import { SectionSelect } from '@/components/shell/SectionHeader';
import { TopbarPlus } from '@/components/shell/topbar-actions';
import { LIST_CARD_GRID } from '@/components/ui/ListCard';
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
import { PipelineDateRangeCalendar } from '@/components/pages/pipeline/PipelineDateRangeCalendar';
import { dispatchSorted } from '@/lib/events';
import { STAGE_TRANSITIONS, stageTransition } from '@srtdio/posts';
import type { Client, PipelinePost, Result, Stage } from '@srtdio/posts';
import { groupByStage } from '@/lib/post-board';
import { POST_SORT_DEFAULT, filterByWindow, sortPosts, type DateWindow } from '@/lib/list-sort';
import { SectionHeader } from '@/components/shell/SectionHeader';
import { INDUCTION_KEYS } from '@/lib/induction';
import { SortMenu } from '@/components/ui/SortMenu';
import { StageChips } from '@/components/pages/pipeline/StageChips';
import type { StageChipItem } from '@/components/pages/pipeline/StageChips';
import { getFillCount } from '@/lib/use-fill-count';

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

// SectionHeader is hookless and holds the chips and Select in props, so it
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

function header(selectMode = false, onSelectToggle: () => void = () => {}): ReactElement {
  return pipelineHeader({
    stage: 'all',
    onStageChange: () => {},
    counts: { all: 3, draft: 2, review: 1 },
    selectMode,
    onSelectToggle,
  });
}

function topbar(
  canCreate: boolean | null = true,
  sort: 'updated' | 'oldest' | 'target' = 'updated',
) {
  return pipelineTopbarActions({
    sort,
    onSortChange: () => {},
    dateWindow: 'any',
    onDateWindowChange: () => {},
    customRange: null,
    onCustomRangeChange: () => {},
    weekStartDay: 1,
    canCreate,
  });
}

describe('pipelineHeader (decisions A, B, E: chips + Select only)', () => {
  it('is the shared SectionHeader with no search, no sort and no New post in the row', () => {
    const tree = header();
    const headers = findAll(tree, (el) => el.type === SectionHeader);
    expect(headers).toHaveLength(1);
    const props = headers[0]!.props as Record<string, unknown>;
    for (const gone of ['search', 'sort', 'primaryAction', 'title']) {
      expect(props).not.toHaveProperty(gone);
    }
    expect(findAll(tree, (el) => el.type === SortMenu)).toHaveLength(0);
    expect(findAll(tree, (el) => el.type === PipelineFilterControl)).toHaveLength(0);
    expect(findAll(tree, (el) => el.type === PipelineSortControl)).toHaveLength(0);
    expect(findAll(tree, (el) => el.type === PipelineDateControl)).toHaveLength(0);
    expect(findAll(tree, (el) => el.type === TopbarPlus)).toHaveLength(0);
    expect(texts(tree)).not.toContain('New post');
  });

  it('keeps the toolbar hook on its wrapper', () => {
    const tree = header();
    const props = tree.props as { className?: string; 'data-pipeline-toolbar'?: string };
    expect(tree.type).toBe('div');
    expect(props['data-pipeline-toolbar']).toBe('');
    expect(props.className).toBeUndefined();
  });

  it('puts the visible Select in the select slot, wired to select mode', () => {
    const toggle = vi.fn();
    const off = findAll(header(false, toggle), (el) => el.type === SectionHeader)[0]!;
    const select = (off.props as { select: ReactElement }).select;
    expect(select.type).toBe(SectionSelect);
    const props = select.props as { active: boolean; onToggle: () => void };
    expect(props.active).toBe(false);
    props.onToggle();
    expect(toggle).toHaveBeenCalledTimes(1);
    const on = findAll(header(true), (el) => el.type === SectionHeader)[0]!;
    expect(
      ((on.props as { select: ReactElement }).select.props as { active: boolean }).active,
    ).toBe(true);
  });

  it('keeps the stage chip bar in the chip slot', () => {
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

describe('pipelineTopbarActions (decision A: sort and "+" in the top bar)', () => {
  it('sort is the one combined Sort + Due date control, wired to the order and window', () => {
    const { sort } = topbar();
    expect(sort.type).toBe(PipelineFilterControl);
    const props = sort.props as {
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

  it('primary is TopbarPlus "New post" with the old induction key, dispatching create-post', () => {
    const { primary } = topbar(true);
    expect(primary).toBeDefined();
    expect(primary!.type).toBe(TopbarPlus);
    const props = primary!.props as { label: string; induction?: string; onClick: () => void };
    expect(props.label).toBe('New post');
    expect(props.induction).toBe(INDUCTION_KEYS.pipelineCreate);
    props.onClick();
    expect(dispatchSorted).toHaveBeenCalledWith('sorted:create-post');
  });

  it('no post.create (an approver): the "+" still shows, blocked with who creates; the sort stays', () => {
    const { sort, primary } = topbar(false);
    expect(primary).toBeDefined();
    expect(primary!.type).toBe(TopbarPlus);
    const props = primary!.props as { label: string; blocked?: { message: string } };
    expect(props.label).toBe('New post');
    expect(props.blocked).toEqual({ message: 'Posts come from creators.' });
    expect(PIPELINE_PLUS_BLOCKED).toBe('Posts come from creators.');
    expect(sort.type).toBe(PipelineFilterControl);
  });

  it('capability still unknown (null): empty slot, never a blocked "+" that turns live', () => {
    const { primary } = topbar(null);
    expect(primary).toBeUndefined();
  });

  it('post.create granted: the live "+" carries no blocked prop', () => {
    const props = topbar(true).primary!.props as { blocked?: unknown };
    expect(props.blocked).toBeUndefined();
  });

  it('the page publishes them with useTopbarActions and gates "+" on post.create', () => {
    const src = readFileSync(fileURLToPath(new URL('./PipelinePage.tsx', import.meta.url)), 'utf8');
    expect(src).toContain('useTopbarActions(topbar)');
    expect(src).toContain("useWorkspaceCapability('post.create');");
    expect(src).toMatch(/pipelineTopbarActions\(\{[\s\S]*?canCreate,[\s\S]*?\}\)/);
  });
});

describe('decision B: no screen search on the Pipeline', () => {
  it('the page holds no search state, search read, debounce or ?q= param', () => {
    const src = readFileSync(fileURLToPath(new URL('./PipelinePage.tsx', import.meta.url)), 'utf8');
    for (const gone of [
      'useServerSearch',
      'searchPipelinePosts',
      'postSearchFields',
      'setSearch',
      'searchActive',
      'searchPending',
      'Search posts',
    ]) {
      expect(src).not.toContain(gone);
    }
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
        stage: initial,
        onStageChange: () => {},
        counts: { all: 3, draft: 2, review: 1 },
        selectMode: false,
        onSelectToggle: () => {},
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
    ).toEqual({ stage: 'review', dateWindow: 'any', customRange: null });
  });
});

describe('the surface', () => {
  function surface(stage: string): ReactElement {
    return pipelineSurface({
      stage,
      sorted: [],
      // The tree is walked and no card is ever expanded, so the cache is untouched.
      cache: {} as unknown as PresignCache,
      presignEnabled: false,
      workspaceKey: null,
      shownKey: 'pipeline:shown:',
    });
  }

  it('threads the select mode down to the feed', () => {
    const selectFor = (id: string) => ({
      active: false,
      chosen: id === 'p1',
      onEnter: () => {},
      onToggle: () => {},
    });
    const tree = pipelineSurface({
      stage: 'all',
      sorted: [],
      cache: {} as unknown as PresignCache,
      presignEnabled: false,
      workspaceKey: null,
      selectFor,
      shownKey: 'pipeline:shown:',
    });
    expect((tree.props as { selectFor?: unknown }).selectFor).toBe(selectFor);
    expect(tree.props).not.toHaveProperty('onLongPressPost');
  });

  it('is the one list (the feed) on phone and laptop for every chip (no board, no Plan week)', () => {
    for (const stage of [...STAGES, 'all', 'plan']) {
      const tree = surface(stage);
      expect(tree.type).toBe(PipelineFeed);
      expect((tree.props as { activeStage: string }).activeStage).toBe(stage);
    }
  });

  it('the page no longer imports the retired kanban', () => {
    const src = readFileSync(fileURLToPath(new URL('./PipelinePage.tsx', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/PipelineBoard|board-columns|BoardColumns|useIsLaptop/);
  });
});

describe('honest post counter (fix 3)', () => {
  // Mirror PipelinePage's derivation exactly: sort -> group -> count -> label.
  // The counter reads the grouped total (counts.all), never a per-stage
  // display cap.
  function deriveLabel(posts: PipelinePost[]): string {
    const grouped = groupByStage(sortPosts(posts, 'updated'), STAGES);
    return postCountLabel(stageCounts(grouped, STAGES).all ?? 0);
  }

  const posts: PipelinePost[] = [
    { ...makePost('1', 'draft'), title: 'Alpha launch' },
    { ...makePost('2', 'review'), title: 'Beta teaser' },
    { ...makePost('3', 'approved'), title: 'Beta recap' },
    { ...makePost('4', 'parked'), title: 'Gamma promo' },
    { ...makePost('5', 'rejected'), title: 'Delta note' },
  ];

  it('reflects the full total across every stage', () => {
    expect(deriveLabel(posts)).toBe('5 posts');
    expect(deriveLabel(posts.slice(0, 1))).toBe('1 post');
  });

  it('counts the filtered total across stages, never the per-stage display cap', () => {
    const many: PipelinePost[] = Array.from({ length: 25 }, (_unused, i) => ({
      ...makePost(`m${i}`, 'draft'),
      title: 'Capped item',
    }));
    // 25 posts in one stage: the total, not a cap of 10.
    expect(deriveLabel(many)).toBe('25 posts');
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

  it("the top bar's active order is the sanitized default for a stale persisted value", () => {
    // Mirror the page: a stale localStorage value (seed sorted:sort:pipeline =
    // 'newest') is sanitized before it reaches the consolidated control's order.
    const { sort } = topbar(true, sanitizePostSort('newest'));
    expect((sort.props as { order: string }).order).toBe(POST_SORT_DEFAULT);
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
    expect(
      customRangeLabel(
        { start: '2026-06-24', end: '2026-06-24' },
        new Date('2026-11-06T12:00:00Z'),
      ),
    ).toBe('24 Jun');
    expect(
      customRangeLabel(
        { start: '2026-06-24', end: '2026-06-27' },
        new Date('2026-11-06T12:00:00Z'),
      ),
    ).toBe('24\u201327 Jun');
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
  // Mirror PipelinePage's derivation: filterByWindow -> count.
  // Fixed now: Wed 2026-06-17 12:00 UTC, so the Mon-Sun week is 2026-06-15..21
  // and the month is June 2026.
  const now = new Date('2026-06-17T12:00:00Z');
  function deriveCount(posts: PipelinePost[], dateWindow: DateWindow): number {
    const filtered = filterByWindow(posts, dateWindow, { now, timeZone: 'UTC', weekStartDay: 1 });
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
    const filtered = filterByWindow(posts, 'custom', {
      now,
      timeZone: 'UTC',
      weekStartDay: 1,
      customRange: { start: '2026-06-16', end: '2026-06-16' },
    });
    const count = stageCounts(groupByStage(filtered, STAGES), STAGES).all ?? 0;
    expect(count).toBe(1);
  });
});

describe('W4 fix 3: create gating', () => {
  it('the "+" is icon-only with "New post" as its accessible label, only with post.create', () => {
    expect(topbar(false).primary).toBeUndefined();
    const plus = topbar(true).primary!;
    expect((plus.props as { label: string }).label).toBe('New post');
    // The old labelled header button and its loading placeholder are gone.
    const src = readFileSync(fileURLToPath(new URL('./PipelinePage.tsx', import.meta.url)), 'utf8');
    expect(src).not.toContain('NEW_POST_CLASS');
    expect(src).not.toContain('data-create-placeholder');
    expect(src).not.toContain('createPending');
  });
});

describe('W4 fix 4: filtered empty state', () => {
  it('renders the shared NoResults for the date filter, wired to the reset', () => {
    const onClear = vi.fn();
    const tree = filteredEmpty(onClear);
    const empty = findAll(tree, (el) => el.type === NoResults)[0]!;
    const props = empty.props as { query?: string; filtersActive: boolean; onClear: () => void };
    expect(props.query).toBeUndefined();
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
  it('a client on a Draft link lands on Review', () => {
    expect(visibleStage('draft', 'client')).toBe('review');
    expect(visibleStage('draft', 'agency')).toBe('draft');
    expect(visibleStage('all', 'client')).toBe('all');
  });
});

describe('E: no jumps while loading', () => {
  it('the skeleton is ListCardBox boxes in the list grid, the same on phone and laptop', () => {
    const out = renderToStaticMarkup(postsSkeleton());
    expect(out).toContain('data-posts-skeleton=""');
    expect(out).toContain('md:grid-cols-list-cards');
    expect((out.match(/data-list-card-box=""/g) ?? []).length).toBe(getFillCount());
    expect(out).toContain(`aria-hidden="true" class="${LIST_CARD_GRID}"`);
    expect(out).not.toContain('kanban');
    expect(out).not.toContain('aspect-ratio');
    expect(out).toContain('<span class="sr-only">Loading posts</span>');
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

describe('select bar actions (the old card ⋮ rows)', () => {
  const noop = (): void => {};
  function actions(
    post: PipelinePost | null,
    count: number,
    viewer: { role: string | null; approverFirstNames: string[]; pending?: boolean },
    onMove: (post: PipelinePost, to?: Stage) => void = noop,
  ) {
    return pipelineSelectActions({ post, count, viewer, onOpen: noop, onCopyLink: noop, onMove });
  }

  it('one ticked post: Open, Copy link, then every move the move sheet offers', async () => {
    const { moveActions } = await import('@/components/pages/pipeline/MoveSheet');
    for (const role of ['client', 'agency', 'owner']) {
      for (const stage of STAGES) {
        const labels = actions(makePost('p1', stage), 1, {
          role,
          approverFirstNames: [],
        }).map((a) => a.label);
        expect(labels.slice(0, 2)).toEqual(['Open', 'Copy link']);
        const moves = moveActions(role, stage).map((m) => m.label);
        expect(labels.slice(2)).toEqual(moves);
        expect(labels).not.toContain('Move');
      }
    }
  });

  it('while the role loads, one Move row opens the move sheet', () => {
    const moved: Array<Stage | undefined> = [];
    const rows = actions(
      makePost('p1', 'draft'),
      1,
      { role: null, approverFirstNames: [], pending: true },
      (_post, to) => moved.push(to),
    );
    expect(rows.map((a) => a.label)).toEqual(['Open', 'Copy link', 'Move']);
    rows.find((a) => a.id === 'move')?.onSelect();
    expect(moved).toEqual([undefined]);
  });

  it('a viewer with no allowed move gets Open and Copy link only', () => {
    expect(
      actions(makePost('p1', 'review'), 1, { role: null, approverFirstNames: [] }).map(
        (a) => a.label,
      ),
    ).toEqual(['Open', 'Copy link']);
  });

  it('two or more ticked: no per-post row (Open, Copy link, moves are single)', () => {
    expect(actions(null, 2, { role: 'agency', approverFirstNames: [] })).toEqual([]);
    expect(actions(makePost('p1', 'draft'), 2, { role: 'agency', approverFirstNames: [] })).toEqual(
      [],
    );
  });

  it('Reject is bad ink; icons: review arrow, approve check, park pause, reject ban (no X)', async () => {
    const icons = await import('@/components/ui/icons');
    const rows = actions(makePost('p1', 'review'), 1, { role: 'client', approverFirstNames: [] });
    const byId = new Map(rows.map((a) => [a.id, a]));
    expect(byId.get('open')?.icon).toBe(icons.IconArrowUpRight);
    expect(byId.get('copy-link')?.icon).toBe(icons.IconLink);
    expect(byId.get('move-approved')?.icon).toBe(icons.IconCheck);
    expect(byId.get('move-rejected')?.icon).toBe(icons.IconBan);
    expect(byId.get('move-rejected')?.tone).toBe('bad');
    expect(byId.get('move-approved')?.tone).toBeUndefined();
    const agency = actions(makePost('p1', 'draft'), 1, { role: 'agency', approverFirstNames: [] });
    expect(new Map(agency.map((a) => [a.id, a])).get('move-review')?.icon).toBe(
      icons.IconArrowUpRight,
    );
  });

  it('a move row hands its target to the page move', () => {
    const moved: Array<Stage | undefined> = [];
    const rows = actions(
      makePost('p1', 'review'),
      1,
      { role: 'client', approverFirstNames: [] },
      (_post, to) => moved.push(to),
    );
    rows.find((a) => a.id === 'move-rejected')?.onSelect();
    expect(moved).toEqual(['rejected']);
  });

  it('the page renders the SelectBar while selecting, labelled Selected posts', () => {
    const src = readFileSync(fileURLToPath(new URL('./PipelinePage.tsx', import.meta.url)), 'utf8');
    expect(src).toContain('useListSelection()');
    expect(src).toContain('label="Selected posts"');
    expect(src).toContain('selection.leaveThen(() => openPostCard(');
  });
});
