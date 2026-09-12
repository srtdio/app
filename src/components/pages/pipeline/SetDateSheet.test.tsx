import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';

// The unit env is `node` with no DOM, so SetDateSheet is invoked as a plain
// function and its returned tree is walked (Sheet is never expanded, its
// children are read straight off the element). useState is shimmed exactly as
// the other pipeline suites do so the "Another date" reveal can be forced.
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
  SetDateSheet,
  currentCivilDay,
  sheetDays,
  type SetDatePost,
} from '@/components/pages/pipeline/SetDateSheet';

// Fixed clock: Wed 2026-09-09 12:00 UTC, inside the 2026-09-07..13 week.
const NOW = new Date('2026-09-09T12:00:00Z');
const WEEK_START = '2026-09-07';

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

function attr(el: ReactElement, name: string): unknown {
  return (el.props as Record<string, unknown>)[name];
}

function textOf(node: ReactNode): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (!isElement(node)) return '';
  return textOf((node.props as { children?: ReactNode }).children);
}

function click(el: ReactElement): void {
  (el.props as { onClick: () => void }).onClick();
}

function post(over: Partial<SetDatePost> = {}): SetDatePost {
  return { id: 'p1', title: 'Launch teaser', target_date: null, ...over };
}

interface Over {
  post?: SetDatePost | null;
  weekStartDay?: number;
  timeZone?: string;
  onPick?: (targetDate: string | null) => void;
  onClose?: () => void;
  saving?: boolean;
}

function render(over: Over = {}): ReactElement | null {
  return SetDateSheet({
    open: true,
    post: over.post === undefined ? post() : over.post,
    weekStart: WEEK_START,
    timeZone: over.timeZone ?? 'UTC',
    weekStartDay: over.weekStartDay ?? 1,
    onPick: over.onPick ?? (() => {}),
    onClose: over.onClose ?? (() => {}),
    saving: over.saving ?? false,
  });
}

function dayButtons(tree: ReactNode): ReactElement[] {
  return findAll(tree, (el) => typeof attr(el, 'data-set-date-day') === 'string');
}

function labelled(tree: ReactNode, label: string): ReactElement | undefined {
  return findAll(
    tree,
    (el) => typeof attr(el, 'onClick') === 'function' && textOf(el) === label,
  )[0];
}

beforeEach(() => {
  hookState.reset();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

describe('SetDateSheet', () => {
  it('renders nothing without a post', () => {
    expect(render({ post: null })).toBeNull();
  });

  it('renders the seven days of the week in weekStartDay order', () => {
    const monday = dayButtons(render({ weekStartDay: 1 }));
    expect(monday.map((el) => attr(el, 'data-set-date-day'))).toEqual(sheetDays(WEEK_START));
    expect(monday).toHaveLength(7);
    expect(textOf(monday[0])).toBe('Mon7');
    expect(textOf(monday[6])).toBe('Sun13');

    hookState.reset();
    const sunday = dayButtons(render({ weekStartDay: 0 }));
    // The week shown is whatever the page hands down; only the NAMES shift.
    expect(textOf(sunday[0])).toBe('Sun7');
  });

  it('carries the week range as an eyebrow and the post title, with no month on the days', () => {
    const tree = render();
    expect(textOf(tree)).toContain('Set target date, 7 Sep to 13 Sep');
    expect(textOf(tree)).toContain('Launch teaser');
    // A day button is the weekday over the day number: never "7 Sep".
    for (const button of dayButtons(tree)) {
      expect(textOf(button)).not.toContain('Sep');
    }
  });

  it('outlines the day the post currently sits on, in the workspace zone', () => {
    // 19:00 UTC on the 7th is the 8th in Asia/Kolkata: the outline follows the
    // workspace reading, not the browser's.
    const tree = render({
      post: post({ target_date: '2026-09-07T19:00:00Z' }),
      timeZone: 'Asia/Kolkata',
    });
    const pressed = dayButtons(tree).filter((el) => attr(el, 'aria-pressed') === true);
    expect(pressed).toHaveLength(1);
    expect(attr(pressed[0]!, 'data-set-date-day')).toBe('2026-09-08');
    expect(String(attr(pressed[0]!, 'className'))).toContain('border-accent-line');
    expect(String(attr(pressed[0]!, 'className'))).toContain('bg-accent-soft');
  });

  it('marks today with the accent and leaves the other days neutral', () => {
    const tree = render();
    const accented = dayButtons(tree).filter(
      (el) =>
        findAll(el, (child) => String(attr(child, 'className')).includes('text-accent')).length > 0,
    );
    expect(accented).toHaveLength(1);
    expect(attr(accented[0]!, 'data-set-date-day')).toBe('2026-09-09');
  });

  it('outlines nothing when the post is undated', () => {
    const tree = render();
    expect(dayButtons(tree).filter((el) => attr(el, 'aria-pressed') === true)).toHaveLength(0);
    expect(currentCivilDay(post(), sheetDays(WEEK_START), 'UTC')).toBeNull();
  });

  it('hands the picked CIVIL date up, never an instant and never a proc', () => {
    const picked: (string | null)[] = [];
    const tree = render({ onPick: (value) => picked.push(value) });
    click(dayButtons(tree)[2]!);
    expect(picked).toEqual(['2026-09-09']);
  });

  it('offers Clear date only when the post is dated, and it picks null', () => {
    expect(labelled(render(), 'Clear date')).toBeUndefined();

    hookState.reset();
    const picked: (string | null)[] = [];
    const dated = render({
      post: post({ target_date: '2026-09-07T09:00:00Z' }),
      onPick: (value) => picked.push(value),
    });
    const clear = labelled(dated, 'Clear date')!;
    expect(String(attr(clear, 'className'))).toContain('text-bad');
    click(clear);
    expect(picked).toEqual([null]);
  });

  it('Another date reveals a native date input that picks a civil value', () => {
    const tree = render();
    expect(findAll(tree, (el) => attr(el, 'type') === 'date')).toHaveLength(0);
    click(labelled(tree, 'Another date')!);
    expect(hookState.calls[0]).toEqual([true]);

    hookState.reset();
    hookState.overrides[0] = true;
    const picked: (string | null)[] = [];
    const revealed = render({ onPick: (value) => picked.push(value) });
    const input = findAll(revealed, (el) => attr(el, 'type') === 'date')[0]!;
    const onChange = attr(input, 'onChange') as (event: { target: { value: string } }) => void;
    onChange({ target: { value: '2026-10-02' } });
    // A cleared native input never writes.
    onChange({ target: { value: '' } });
    expect(picked).toEqual(['2026-10-02']);
  });

  it('Cancel closes without picking', () => {
    let closed = 0;
    const picked: (string | null)[] = [];
    const tree = render({ onClose: () => (closed += 1), onPick: (value) => picked.push(value) });
    click(labelled(tree, 'Cancel')!);
    expect(closed).toBe(1);
    expect(picked).toEqual([]);
  });

  it('disables every control while the write is in flight', () => {
    hookState.overrides[0] = true;
    const tree = render({ post: post({ target_date: '2026-09-07T09:00:00Z' }), saving: true });
    const controls = findAll(
      tree,
      (el) => typeof attr(el, 'onClick') === 'function' || attr(el, 'type') === 'date',
    );
    expect(controls.length).toBeGreaterThan(8);
    for (const control of controls) {
      expect(attr(control, 'disabled')).toBe(true);
    }
  });

  it('every control is at least a 44px touch target (the days are 56px)', () => {
    hookState.overrides[0] = true;
    const tree = render({ post: post({ target_date: '2026-09-07T09:00:00Z' }) });
    for (const day of dayButtons(tree)) {
      expect(String(attr(day, 'className'))).toContain('min-h-[56px]');
    }
    const buttons = findAll(
      tree,
      (el) =>
        typeof attr(el, 'onClick') === 'function' && attr(el, 'data-set-date-day') === undefined,
    );
    for (const button of buttons) {
      expect((button.props as { size?: string }).size).toBe('lg');
    }
    expect(
      String(attr(findAll(tree, (el) => attr(el, 'type') === 'date')[0]!, 'className')),
    ).toContain('min-h-[44px]');
  });
});
