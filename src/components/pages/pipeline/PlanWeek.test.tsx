import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';

// The unit env is `node` with no DOM, so PlanWeek is invoked as a plain function
// and its returned tree is walked (PostCard is never expanded). Its hooks are
// shimmed: useState records its setters per call index so a test can force a
// state and observe a setter firing, useMemo runs eagerly, useRef hands back a
// plain box, and useEffect is inert (the desktop scroll-into-view is a DOM
// effect with nothing to assert without a DOM; PlanWeek guards it with a typeof
// check for exactly that reason). Mirrors PipelinePage.test's shim.
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
    useMemo: (factory: () => unknown) => factory(),
    useRef: (init: unknown) => ({ current: init }),
    useEffect: () => {},
  };
});

import { PlanWeek } from '@/components/pages/pipeline/PlanWeek';
import { BOARD_CAP } from '@/components/pages/pipeline/stage-meta';
import { weekBounds } from '@/lib/plan-week';
import type { PresignCache } from '@/lib/asset-presign';
import type { PipelinePost, Stage } from '@srtdio/posts';

// Fixed clock: Wed 2026-09-09 12:00 UTC. With a Monday week start the week is
// 2026-09-07..13 and "today" is the 9th.
const NOW = new Date('2026-09-09T12:00:00Z');

// The tree is walked and PostCard is never invoked, so the cache is never
// touched: a bare stub satisfies the type.
const cache = {} as unknown as PresignCache;

function makePost(id: string, target: string | null): PipelinePost {
  return {
    id,
    workspace_id: 'w',
    number: 1,
    title: `Post ${id}`,
    stage: 'draft' as Stage,
    platform: 'instagram',
    format: 'reel',
    origin: 'manual',
    legacy_author_name: null,
    caption: null,
    brief_id: null,
    bucket_id: null,
    owner_user_id: 'u',
    created_by: 'u',
    target_date: target,
    deleted_at: null,
    row_version: 1,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    stage_entered_at: '2026-01-01',
    thumbnailAssetVersionId: null,
  };
}

function isElement(node: ReactNode): node is ReactElement {
  return typeof node === 'object' && node !== null && 'props' in node;
}

function collect(node: ReactNode, found: ReactElement[]): void {
  if (Array.isArray(node)) {
    node.forEach((child) => collect(child, found));
    return;
  }
  if (!isElement(node)) return;
  found.push(node);
  collect((node.props as { children?: ReactNode }).children, found);
}

function all(tree: ReactNode): ReactElement[] {
  const found: ReactElement[] = [];
  collect(tree, found);
  return found;
}

function findAll(tree: ReactNode, predicate: (el: ReactElement) => boolean): ReactElement[] {
  return all(tree).filter(predicate);
}

/** Every string/number leaf under an element, concatenated; the visible text. */
function textOf(node: ReactNode): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (!isElement(node)) return '';
  return textOf((node.props as { children?: ReactNode }).children);
}

function attr(el: ReactElement, name: string): unknown {
  return (el.props as Record<string, unknown>)[name];
}

function dayColumns(tree: ReactNode): ReactElement[] {
  return findAll(tree, (el) => typeof attr(el, 'data-plan-day') === 'string');
}

/** The weekday names of the rendered day headings, in render order. */
function dayNames(tree: ReactNode): string[] {
  return findAll(tree, (el) => attr(el, 'data-plan-day-name') === true).map(textOf);
}

function tileIds(scope: ReactNode): string[] {
  return findAll(scope, (el) => typeof attr(el, 'data-post-id') === 'string').map(
    (el) => attr(el, 'data-post-id') as string,
  );
}

function undatedSection(tree: ReactNode): ReactElement | undefined {
  return findAll(tree, (el) => attr(el, 'data-plan-undated') === true)[0];
}

interface Over {
  posts?: PipelinePost[];
  weekStartDay?: number;
  offset?: number;
  isDesktop?: boolean;
  onOffsetChange?: (offset: number) => void;
  timeZone?: string;
}

function render(over: Over = {}): ReactElement {
  return PlanWeek({
    posts: over.posts ?? [],
    timeZone: over.timeZone ?? 'UTC',
    weekStartDay: over.weekStartDay ?? 1,
    offset: over.offset ?? 0,
    onOffsetChange: over.onOffsetChange ?? (() => {}),
    isDesktop: over.isDesktop ?? true,
    cache,
    presignEnabled: false,
    workspaceKey: null,
  });
}

function button(tree: ReactNode, label: string): ReactElement {
  const found = findAll(tree, (el) => attr(el, 'aria-label') === label);
  expect(found).toHaveLength(1);
  return found[0]!;
}

function click(el: ReactElement): void {
  (el.props as { onClick: () => void }).onClick();
}

beforeEach(() => {
  hookState.reset();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

// The week grid is withheld by the whole-view empty state when NOTHING is
// dated and nothing is undated, so the grid cases seed one dated post.
const SEED = [makePost('seed', '2026-09-07T09:00:00Z')];

describe('PlanWeek week grid', () => {
  it('renders the seven days of the week in order for a Monday week start', () => {
    const tree = render({ weekStartDay: 1, posts: SEED });
    const days = dayColumns(tree).map((el) => attr(el, 'data-plan-day'));
    expect(days).toEqual(
      weekBounds({ now: NOW, timeZone: 'UTC', weekStartDay: 1, offset: 0 }).days,
    );
    expect(days[0]).toBe('2026-09-07');
    // The headings read Mon..Sun, in that order.
    expect(dayNames(tree)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  });

  it('honours a Sunday week start: the grid shifts a day and reads Sun..Sat', () => {
    const tree = render({ weekStartDay: 0, posts: SEED });
    const days = dayColumns(tree).map((el) => attr(el, 'data-plan-day'));
    expect(days[0]).toBe('2026-09-06');
    expect(days).toHaveLength(7);
    expect(dayNames(tree)).toEqual(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
  });

  it('groups each post under the day its target date falls on', () => {
    const posts = [
      makePost('mon', '2026-09-07T09:00:00Z'),
      makePost('wed', '2026-09-09T09:00:00Z'),
      makePost('mon2', '2026-09-07T20:00:00Z'),
      makePost('next-week', '2026-09-20T09:00:00Z'),
    ];
    const columns = dayColumns(render({ posts }));
    const byDay = Object.fromEntries(
      columns.map((el) => [attr(el, 'data-plan-day') as string, tileIds(el)]),
    );
    expect(byDay['2026-09-07']).toEqual(['mon', 'mon2']);
    expect(byDay['2026-09-09']).toEqual(['wed']);
    expect(byDay['2026-09-08']).toEqual([]);
    // A post outside the shown week appears nowhere on this surface.
    expect(Object.values(byDay).flat()).not.toContain('next-week');
  });

  it("marks today's column with the accent border, and only today's", () => {
    const columns = dayColumns(render({ posts: SEED }));
    const accented = columns.filter((el) =>
      String(attr(el, 'className')).includes('border-accent-line'),
    );
    expect(accented).toHaveLength(1);
    expect(attr(accented[0]!, 'data-plan-day')).toBe('2026-09-09');
  });

  it('an empty desktop column reads "Nothing dated"', () => {
    const tree = render({ posts: [makePost('a', '2026-09-07T09:00:00Z')] });
    const tuesday = dayColumns(tree).find((el) => attr(el, 'data-plan-day') === '2026-09-08')!;
    expect(textOf(tuesday)).toContain('Nothing dated');
  });

  it('an empty phone day renders the dashed placeholder instead of a grid', () => {
    const tree = render({ isDesktop: false, posts: [makePost('a', '2026-09-07T09:00:00Z')] });
    const placeholders = findAll(tree, (el) => attr(el, 'data-plan-day-empty') === true);
    // Six of the seven days are empty.
    expect(placeholders).toHaveLength(6);
    expect(String(attr(placeholders[0]!, 'className'))).toContain('h-9');
    expect(String(attr(placeholders[0]!, 'className'))).toContain('border-dashed');
  });
});

describe('PlanWeek undated block', () => {
  function undatedPosts(n: number): PipelinePost[] {
    return Array.from({ length: n }, (_unused, i) => makePost(`u${i}`, null));
  }

  it('sits ABOVE the week and carries its count plus the muted hint', () => {
    const tree = render({ posts: undatedPosts(2) });
    const order = all(tree);
    const undatedIndex = order.findIndex((el) => attr(el, 'data-plan-undated') === true);
    const firstDayIndex = order.findIndex((el) => typeof attr(el, 'data-plan-day') === 'string');
    expect(undatedIndex).toBeGreaterThanOrEqual(0);
    expect(undatedIndex).toBeLessThan(firstDayIndex);
    const text = textOf(undatedSection(tree));
    expect(text).toContain('Undated');
    expect(text).toContain('2');
    expect(text).toContain('no target date yet');
  });

  it('caps the undated list at the board cap and offers Show more', () => {
    const tree = render({ posts: undatedPosts(BOARD_CAP + 2) });
    expect(tileIds(undatedSection(tree))).toHaveLength(BOARD_CAP);
    expect(textOf(undatedSection(tree))).toContain('Show 2 more');
  });

  it('Show more reveals the rest in place', () => {
    const tree = render({ posts: undatedPosts(BOARD_CAP + 2) });
    const more = findAll(
      undatedSection(tree),
      (el) => typeof attr(el, 'onClick') === 'function' && textOf(el).includes('Show'),
    )[0]!;
    click(more);
    // The reveal is a state bump of one cap, applied in place (no navigation).
    const updater = hookState.calls[0]![0] as (prev: number) => number;
    expect(updater(BOARD_CAP)).toBe(BOARD_CAP * 2);

    // Re-render at the revealed depth: every undated post is listed, no control left.
    hookState.reset();
    hookState.overrides[0] = BOARD_CAP * 2;
    const revealed = render({ posts: undatedPosts(BOARD_CAP + 2) });
    expect(tileIds(undatedSection(revealed))).toHaveLength(BOARD_CAP + 2);
    expect(textOf(undatedSection(revealed))).not.toContain('Show');
  });

  it('reads "Every post has a date." when nothing is undated', () => {
    const tree = render({ posts: [makePost('a', '2026-09-07T09:00:00Z')] });
    expect(textOf(undatedSection(tree))).toContain('Every post has a date.');
  });
});

describe('PlanWeek empty and header', () => {
  it('shows the whole-view empty state when the week and undated are both empty', () => {
    const tree = render({ posts: [] });
    expect(findAll(tree, (el) => attr(el, 'data-plan-empty') === true)).toHaveLength(1);
    expect(textOf(tree)).toContain(
      'Nothing dated this week. Set a target date on a post to see it here.',
    );
    // The week grid and the undated block are both withheld.
    expect(dayColumns(tree)).toHaveLength(0);
    expect(undatedSection(tree)).toBeUndefined();
  });

  it('keeps the week grid when only the undated block has content', () => {
    const tree = render({ posts: [makePost('u', null)] });
    expect(findAll(tree, (el) => attr(el, 'data-plan-empty') === true)).toHaveLength(0);
    expect(dayColumns(tree)).toHaveLength(7);
  });

  it('labels the week and its range from the workspace week start', () => {
    expect(textOf(render({ offset: 0 }))).toContain('This week');
    expect(textOf(render({ offset: 0 }))).toContain('7 Sep');
    expect(textOf(render({ offset: 0 }))).toContain('13 Sep');
    expect(textOf(render({ offset: -1 }))).toContain('Last week');
    expect(textOf(render({ offset: 1 }))).toContain('Next week');
    expect(textOf(render({ offset: 2 }))).toContain('21 Sep');
  });

  it('the arrows step the offset by one week in each direction', () => {
    const moves: number[] = [];
    const onOffsetChange = (next: number): void => {
      moves.push(next);
    };
    const tree = render({ offset: 0, onOffsetChange });
    click(button(tree, 'Previous week'));
    click(button(tree, 'Next week'));
    expect(moves).toEqual([-1, 1]);

    hookState.reset();
    const shifted = render({ offset: 2, onOffsetChange });
    click(button(shifted, 'Previous week'));
    click(button(shifted, 'Next week'));
    expect(moves).toEqual([-1, 1, 1, 3]);
  });

  it('offers Today only away from this week, and it resets the offset to 0', () => {
    const moves: number[] = [];
    const onOffsetChange = (next: number): void => {
      moves.push(next);
    };
    const atToday = render({ offset: 0, onOffsetChange });
    expect(findAll(atToday, (el) => textOf(el) === 'Today')).toHaveLength(0);

    hookState.reset();
    const away = render({ offset: -2, onOffsetChange });
    const today = findAll(away, (el) => textOf(el) === 'Today');
    expect(today).toHaveLength(1);
    click(today[0]!);
    expect(moves).toEqual([0]);
  });

  it('every control is at least a 44px touch target', () => {
    const tree = render({ offset: 1 });
    const controls = findAll(tree, (el) => typeof attr(el, 'onClick') === 'function');
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      // size="lg" is the h-11 (44px) Button size; the arrows add w-11.
      expect((control.props as { size?: string }).size).toBe('lg');
    }
  });
});
