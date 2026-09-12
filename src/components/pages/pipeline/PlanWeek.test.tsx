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

import { PlanWeek, isTypingTarget, planKeyHandler } from '@/components/pages/pipeline/PlanWeek';
import { BOARD_CAP, StageDot } from '@/components/pages/pipeline/stage-meta';
import { weekBounds } from '@/lib/plan-week';
import type { PresignCache } from '@/lib/asset-presign';
import type { PipelinePost, Stage } from '@srtdio/posts';

// Fixed clock: Wed 2026-09-09 12:00 UTC. With a Monday week start the week is
// 2026-09-07..13 and "today" is the 9th.
const NOW = new Date('2026-09-09T12:00:00Z');

// The tree is walked and PostCard is never invoked, so the cache is never
// touched: a bare stub satisfies the type.
const cache = {} as unknown as PresignCache;

function makePost(id: string, target: string | null, stage: Stage = 'draft'): PipelinePost {
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
  canSetDate?: boolean;
  onSetDate?: (post: PipelinePost) => void;
  onAddOnDay?: (civil: string) => void;
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
    canSetDate: over.canSetDate ?? false,
    onSetDate: over.onSetDate ?? (() => {}),
    onAddOnDay: over.onAddOnDay ?? (() => {}),
    sheetOpen: false,
  });
}

/** Open the undated block: it is collapsed on mount, so its state is forced. */
function openUndated(): void {
  hookState.overrides[1] = true;
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

  it('an empty desktop column offers "Add post" for that day', () => {
    const tree = render({ posts: [makePost('a', '2026-09-07T09:00:00Z')] });
    const tuesday = dayColumns(tree).find((el) => attr(el, 'data-plan-day') === '2026-09-08')!;
    expect(textOf(tuesday)).toContain('Add post');
  });

  it('an empty phone day renders the dashed Add post placeholder instead of a grid', () => {
    const tree = render({ isDesktop: false, posts: [makePost('a', '2026-09-07T09:00:00Z')] });
    const placeholders = findAll(tree, (el) => attr(el, 'data-plan-day-empty') === true);
    // Six of the seven days are empty.
    expect(placeholders).toHaveLength(6);
    expect(String(attr(placeholders[0]!, 'className'))).toContain('min-h-[44px]');
    expect(String(attr(placeholders[0]!, 'className'))).toContain('border-dashed');
  });

  it('headings read "Mon 7 Sep": the weekday, a space, then the day and month', () => {
    for (const isDesktop of [true, false]) {
      hookState.reset();
      const tree = render({ isDesktop, posts: SEED });
      const heading = dayColumns(tree)[0]!;
      expect(textOf(heading)).toContain('Mon 7 Sep');
    }
  });

  it('a past day heading is muted, today keeps the accent, the future is neutral', () => {
    const tree = render({ posts: SEED });
    function tone(day: string): string {
      const column = dayColumns(tree).find((el) => attr(el, 'data-plan-day') === day)!;
      const name = findAll(column, (el) => attr(el, 'data-plan-day-name') === true)[0]!;
      return String(attr(name, 'className'));
    }
    expect(tone('2026-09-07')).toContain('text-fg-3');
    expect(tone('2026-09-09')).toContain('text-accent');
    expect(tone('2026-09-11')).not.toContain('text-fg-3');
    expect(tone('2026-09-11')).not.toContain('text-accent');
  });

  it('tapping an empty day asks the page to create a post on that civil date', () => {
    const picked: string[] = [];
    const tree = render({
      posts: [makePost('a', '2026-09-07T09:00:00Z')],
      onAddOnDay: (civil) => picked.push(civil),
    });
    const tuesday = findAll(tree, (el) => attr(el, 'data-plan-day-add') === '2026-09-08')[0]!;
    click(tuesday);
    expect(picked).toEqual(['2026-09-08']);
  });
});

describe('PlanWeek stage dots', () => {
  const posts = [
    makePost('a', '2026-09-07T09:00:00Z', 'rejected'),
    makePost('b', '2026-09-07T10:00:00Z', 'review'),
    makePost('c', '2026-09-07T11:00:00Z', 'review'),
  ];

  it('shows one dot per distinct stage that day, in the canonical order', () => {
    const tree = render({ posts });
    const row = findAll(tree, (el) => attr(el, 'data-plan-day-stages') === '2026-09-07')[0]!;
    const stages = findAll(row, (el) => el.type === StageDot).map((el) => attr(el, 'stage'));
    // review precedes rejected in the transition map, and the duplicate collapses.
    expect(stages).toEqual(['review', 'rejected']);
  });

  it('renders no dot row for an empty day, and none at all on phone', () => {
    const tree = render({ posts });
    expect(findAll(tree, (el) => attr(el, 'data-plan-day-stages') === '2026-09-08')).toHaveLength(
      0,
    );
    hookState.reset();
    const phone = render({ posts, isDesktop: false });
    expect(
      findAll(phone, (el) => typeof attr(el, 'data-plan-day-stages') === 'string'),
    ).toHaveLength(0);
  });
});

describe('PlanWeek set-date button', () => {
  const posts = [makePost('dated', '2026-09-07T09:00:00Z'), makePost('undated', null)];

  function dateButtons(tree: ReactElement): ReactElement[] {
    return findAll(tree, (el) => attr(el, 'aria-label') === 'Set target date');
  }

  it('renders no calendar button for a client (canSetDate false)', () => {
    openUndated();
    expect(dateButtons(render({ posts, canSetDate: false }))).toHaveLength(0);
  });

  it('renders one per tile for the agency side, accented while the post is undated', () => {
    openUndated();
    const tree = render({ posts, canSetDate: true });
    const buttons = dateButtons(tree);
    expect(buttons).toHaveLength(2);
    const byPost = Object.fromEntries(
      buttons.map((el) => [
        attr(el, 'data-plan-set-date') as string,
        String(attr(el, 'className')),
      ]),
    );
    expect(byPost.undated).toContain('text-accent');
    expect(byPost.dated).toContain('text-fg-2');
    // 44x44 target, above the card, and it never navigates.
    expect(byPost.dated).toContain('h-11');
    expect(byPost.dated).toContain('w-11');
  });

  it('calls up to the page with the post, never a proc of its own', () => {
    const opened: string[] = [];
    const tree = render({
      posts: [makePost('dated', '2026-09-07T09:00:00Z')],
      canSetDate: true,
      onSetDate: (post) => opened.push(post.id),
    });
    click(dateButtons(tree)[0]!);
    expect(opened).toEqual(['dated']);
  });
});

describe('PlanWeek past-date marker', () => {
  function markers(tree: ReactElement): ReactElement[] {
    return findAll(tree, (el) => attr(el, 'data-plan-past-marker') === true);
  }

  function tileFor(tree: ReactElement, id: string): ReactElement {
    return findAll(tree, (el) => attr(el, 'data-post-id') === id)[0]!;
  }

  it('marks a past, not-approved post and reads out why', () => {
    const tree = render({ posts: [makePost('late', '2026-09-07T09:00:00Z', 'review')] });
    expect(markers(tree)).toHaveLength(1);
    expect(textOf(tileFor(tree, 'late'))).toContain('Past date, not approved');
  });

  it('never marks an approved post, today, the future, or an undated post', () => {
    openUndated();
    const tree = render({
      posts: [
        makePost('past-approved', '2026-09-07T09:00:00Z', 'approved'),
        makePost('today', '2026-09-09T09:00:00Z', 'review'),
        makePost('future', '2026-09-11T09:00:00Z', 'draft'),
        makePost('undated', null, 'review'),
      ],
    });
    expect(markers(tree)).toHaveLength(0);
  });
});

describe('PlanWeek keyboard arrows', () => {
  const base = { isDesktop: true, sheetOpen: false, offset: 0 };

  function fired(over: Partial<typeof base> = {}, event = { key: 'ArrowRight', target: null }) {
    const moves: number[] = [];
    planKeyHandler({ ...base, ...over, onOffsetChange: (next) => moves.push(next) })(event);
    return moves;
  }

  it('steps the week left and right', () => {
    expect(fired({}, { key: 'ArrowLeft', target: null })).toEqual([-1]);
    expect(fired({}, { key: 'ArrowRight', target: null })).toEqual([1]);
    expect(fired({ offset: 2 }, { key: 'ArrowRight', target: null })).toEqual([3]);
  });

  it('ignores every other key', () => {
    expect(fired({}, { key: 'ArrowUp', target: null })).toEqual([]);
    expect(fired({}, { key: 'a', target: null })).toEqual([]);
  });

  it('stands down on phone and while any sheet is open', () => {
    expect(fired({ isDesktop: false })).toEqual([]);
    expect(fired({ sheetOpen: true })).toEqual([]);
  });

  it('never steals the key from a field the user is typing in', () => {
    for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) {
      expect(isTypingTarget({ tagName: tag } as unknown as EventTarget)).toBe(true);
      expect(
        planKeyHandlerMoves({
          key: 'ArrowRight',
          target: { tagName: tag } as unknown as EventTarget,
        }),
      ).toEqual([]);
    }
    expect(isTypingTarget({ isContentEditable: true } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV' } as unknown as EventTarget)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  function planKeyHandlerMoves(event: { key: string; target: EventTarget | null }): number[] {
    const moves: number[] = [];
    planKeyHandler({ ...base, onOffsetChange: (next) => moves.push(next) })(event);
    return moves;
  }
});

describe('PlanWeek undated block', () => {
  function undatedPosts(n: number): PipelinePost[] {
    return Array.from({ length: n }, (_unused, i) => makePost(`u${i}`, null));
  }

  function toggle(tree: ReactNode): ReactElement {
    return findAll(tree, (el) => attr(el, 'data-plan-undated-toggle') === true)[0]!;
  }

  it('sits ABOVE the week and carries its count plus the approved tally', () => {
    const tree = render({
      posts: [makePost('u0', null, 'approved'), makePost('u1', null, 'draft')],
    });
    const order = all(tree);
    const undatedIndex = order.findIndex((el) => attr(el, 'data-plan-undated') === true);
    const firstDayIndex = order.findIndex((el) => typeof attr(el, 'data-plan-day') === 'string');
    expect(undatedIndex).toBeGreaterThanOrEqual(0);
    expect(undatedIndex).toBeLessThan(firstDayIndex);
    const text = textOf(undatedSection(tree));
    expect(text).toContain('Undated');
    expect(text).toContain('2');
    expect(text).toContain('1 approved');
  });

  it('is COLLAPSED on mount: the row is a 44px toggle and no tile is rendered', () => {
    const tree = render({ posts: undatedPosts(3) });
    const row = toggle(tree);
    expect(attr(row, 'aria-expanded')).toBe(false);
    expect(String(attr(row, 'className'))).toContain('h-11');
    expect(tileIds(undatedSection(tree))).toHaveLength(0);
    // The chevron is upright while collapsed; opening is a static rotation.
    const chevron = findAll(row, (el) => String(attr(el, 'className')).includes('rotate-180'));
    expect(chevron).toHaveLength(0);
  });

  it('the toggle flips the open state, and the chevron rotates when open', () => {
    const tree = render({ posts: undatedPosts(3) });
    click(toggle(tree));
    const updater = hookState.calls[1]![0] as (prev: boolean) => boolean;
    expect(updater(false)).toBe(true);

    hookState.reset();
    openUndated();
    const open = render({ posts: undatedPosts(3) });
    expect(attr(toggle(open), 'aria-expanded')).toBe(true);
    expect(tileIds(undatedSection(open))).toHaveLength(3);
    expect(
      findAll(toggle(open), (el) => String(attr(el, 'className')).includes('rotate-180')),
    ).toHaveLength(1);
  });

  it('lists the open block by urgency: approved first, rejected last', () => {
    openUndated();
    const tree = render({
      posts: [
        makePost('r', null, 'rejected'),
        makePost('d', null, 'draft'),
        makePost('a', null, 'approved'),
        makePost('v', null, 'review'),
        makePost('p', null, 'parked'),
      ],
    });
    expect(tileIds(undatedSection(tree))).toEqual(['a', 'v', 'd', 'p', 'r']);
  });

  it('caps the open undated list at the board cap and offers Show more', () => {
    openUndated();
    const tree = render({ posts: undatedPosts(BOARD_CAP + 2) });
    expect(tileIds(undatedSection(tree))).toHaveLength(BOARD_CAP);
    expect(textOf(undatedSection(tree))).toContain('Show 2 more');
  });

  it('Show more reveals the rest in place', () => {
    openUndated();
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
    openUndated();
    const revealed = render({ posts: undatedPosts(BOARD_CAP + 2) });
    expect(tileIds(undatedSection(revealed))).toHaveLength(BOARD_CAP + 2);
    expect(textOf(undatedSection(revealed))).not.toContain('Show');
  });

  it('reads "Every post has a date." when opened with nothing undated', () => {
    openUndated();
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
    openUndated();
    const tree = render({
      offset: 1,
      canSetDate: true,
      posts: [makePost('a', '2026-09-14T09:00:00Z'), makePost('u', null)],
    });
    const controls = findAll(tree, (el) => typeof attr(el, 'onClick') === 'function');
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      // Either the h-11 (44px) Button size, or a raw button whose own class
      // pins the height: h-11 (toggle, calendar) or min-h-[44px] (Add post).
      const size = (control.props as { size?: string }).size;
      const className = String(attr(control, 'className'));
      // Either the h-11 (44px) Button size, or a raw button whose own class pins
      // the height: h-11 (toggle, calendar) or a min-h of at least 44px.
      const minH = /min-h-\[(\d+)px\]/.exec(className);
      const pinned = /(^|\s)h-11(\s|$)/.test(className) || (minH !== null && Number(minH[1]) >= 44);
      expect(size === 'lg' || pinned).toBe(true);
    }
  });
});
