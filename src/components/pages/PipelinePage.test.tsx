import { afterEach, describe, expect, it, vi } from 'vitest';
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
// unexpanded element node), so we mock the two hooks it touches: useMediaQuery is
// stubbed to a fixed breakpoint, and useState is a pure shim that records its
// setters per call index (0 = sheet/popover open, 1 = calendar open) so a test
// can force initial state and observe a setter firing without a renderer.
vi.mock('@/lib/use-media-query', () => ({ useMediaQuery: () => true }));

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
  isUndoableMove,
  moveErrorMessage,
  pipelineHeader,
  pipelineSurface,
  postCountLabel,
  runMovePost,
  runUndoableMove,
  undoMoveLabel,
  sanitizePostSort,
  stageCounts,
} from '@/components/pages/PipelinePage';
import type { MovePostDeps } from '@/components/pages/PipelinePage';
import { parsePipelineQuery } from '@/components/pages/pipeline/pipeline-query';
import type { UndoableAction } from '@/lib/use-undoable-action';
import { EmptyState } from '@/components/ui/EmptyState';
import { PipelineBoard } from '@/components/pages/pipeline/PipelineBoard';
import { PipelineFeed } from '@/components/pages/pipeline/PipelineFeed';
import type { PresignCache } from '@/lib/asset-presign';
import {
  PipelineDateControl,
  PipelineSortControl,
  customRangeLabel,
  dateControlBody,
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

function isNewPost(el: ReactElement): boolean {
  return (el.props as { children?: ReactNode }).children === 'New post';
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
  it('uses the shared SectionHeader with the sort and date controls (no raw SortMenu)', () => {
    const tree = header();
    expect(findAll(tree, (el) => el.type === SectionHeader)).toHaveLength(1);
    // The header now hands SectionHeader a node, not the declarative SortMenu.
    expect(findAll(tree, (el) => el.type === SortMenu)).toHaveLength(0);
    expect(findAll(tree, (el) => el.type === PipelineSortControl)).toHaveLength(1);
    expect(findAll(tree, (el) => el.type === PipelineDateControl)).toHaveLength(1);
  });

  it('passes the sort to SectionHeader as a { node } holding the date and sort buttons', () => {
    const headers = findAll(header(), (el) => el.type === SectionHeader);
    expect(headers).toHaveLength(1);
    const sort = (headers[0]!.props as { sort: { node?: ReactElement } }).sort;
    expect(sort.node).toBeDefined();
    const inner = findAll(sort.node, (el) => el !== sort.node).map((el) => el.type);
    // The date filter sits before Sort, each its own button.
    expect(inner).toEqual([PipelineDateControl, PipelineSortControl]);
  });

  it('wires the active order to Sort and the date-window state to the date control', () => {
    const sortControls = findAll(header(), (el) => el.type === PipelineSortControl);
    expect(sortControls).toHaveLength(1);
    expect((sortControls[0]!.props as { order: string }).order).toBe('updated');
    const dateControls = findAll(header(), (el) => el.type === PipelineDateControl);
    expect(dateControls).toHaveLength(1);
    const props = dateControls[0]!.props as {
      dateWindow: string;
      customRange: unknown;
      weekStartDay: number;
    };
    expect(props.dateWindow).toBe('any');
    expect(props.customRange).toBeNull();
    expect(props.weekStartDay).toBe(1);
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
    for (const code of [
      'invalid_stage_transition',
      'forbidden_role',
      'workspace_member_only',
      'unknown',
    ] as const) {
      expect(moveErrorMessage(code)).toBe("Couldn't move the post. Try again.");
      expect(moveErrorMessage(code)).not.toContain(code);
    }
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

  it('client role: a park or back-to-review never reaches the proc', async () => {
    stMock.mockClear();
    for (const [from, to] of [
      ['review', 'parked'],
      ['approved', 'parked'],
      ['rejected', 'review'],
    ] as [Stage, Stage][]) {
      const h = harness([makePost('p1', from)]);
      await runMovePost({ ...h.deps, role: 'client' }, 'p1', to);
      expect(h.setPostsCalls()).toBe(0);
      expect(h.toasts).toEqual([]);
    }
    expect(stMock).not.toHaveBeenCalled();
  });

  it('client role: approve and reject still reach the proc', async () => {
    stMock.mockResolvedValue({ ok: true, data: 'p1' } satisfies Result<string>);
    const h = harness([makePost('p1', 'review')]);
    await runMovePost({ ...h.deps, role: 'client' }, 'p1', 'approved');
    expect(h.state()[0]!.stage).toBe('approved');
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

  it('offline: a fetch failure toasts "Couldn\'t move the post. You\'re offline." with Retry', async () => {
    stMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const h = harness([makePost('p1', 'draft')]);
    const failures: Array<{ message: string; retry: boolean }> = [];
    const deps: MovePostDeps = {
      ...h.deps,
      toast: (message, failure) => failures.push({ message, retry: failure?.retry !== undefined }),
    };

    await runMovePost(deps, 'p1', 'review');

    expect(failures).toEqual([{ message: "Couldn't move the post. You're offline.", retry: true }]);
  });

  it('a refusal toasts as a failure with no Retry', async () => {
    stMock.mockResolvedValue({
      ok: false,
      error: { code: 'forbidden_role', message: 'forbidden_role' },
    } satisfies Result<string>);
    const h = harness([makePost('p1', 'draft')]);
    const failures: Array<{ message: string; failed: boolean; retry: boolean }> = [];
    const deps: MovePostDeps = {
      ...h.deps,
      toast: (message, failure) =>
        failures.push({
          message,
          failed: failure !== undefined,
          retry: failure?.retry !== undefined,
        }),
    };

    await runMovePost(deps, 'p1', 'review');

    expect(failures).toEqual([
      {
        message: "Couldn't move the post. You don't have access to do this.",
        failed: true,
        retry: false,
      },
    ]);
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
    const controls = findAll(tree, (el) => el.type === PipelineSortControl);
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

  it('Sort lists Newest first, Oldest first and Due soonest first and fires onOrderChange', () => {
    let picked: string | null = null;
    const rows = menuRows(
      body({
        onOrderChange: (o) => {
          picked = o;
        },
      }),
    );
    expect(rows.map(rowLabel)).toEqual(['Newest first', 'Oldest first', 'Due soonest first']);
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
    expect(findAll(header(true), (el) => el.type === IconPlus)).toHaveLength(0);
    expect(
      findAll(
        header(true),
        (el) => (el.props as { 'aria-label'?: string })['aria-label'] === 'Create post',
      ),
    ).toHaveLength(0);
  });
});

describe('W4 fix 4: filtered empty state', () => {
  it('says "Nothing fits these filters" with a Clear filters button that fires the reset', () => {
    const onClear = vi.fn();
    const tree = filteredEmpty(onClear);
    const empty = findAll(tree, (el) => el.type === EmptyState)[0]!;
    const props = empty.props as { title: string; action: ReactElement };
    expect(props.title).toBe('Nothing fits these filters');
    expect(texts(props.action)).toContain('Clear filters');
    (props.action.props as { onClick: () => void }).onClick();
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});

describe('W4 fix 6 (revised): the date filter is its own button, no chip under the header', () => {
  it('the page no longer renders a date chip with a Clear date filter X', () => {
    const src = readFileSync(fileURLToPath(new URL('./PipelinePage.tsx', import.meta.url)), 'utf8');
    expect(src).not.toContain('dateFilterChip');
    expect(src).not.toContain('Clear date filter');
    expect(src).toContain('PipelineDateControl');
  });
});

describe('W4 fix 7: undoable Rejected / Parked moves', () => {
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

  it('only Rejected and Parked are undoable, with the "Moved to X" label', () => {
    expect(STAGES.filter(isUndoableMove)).toEqual(['parked', 'rejected']);
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
