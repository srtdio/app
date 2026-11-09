// @vitest-environment jsdom
// Activity's top bar (10 Nov 2026): Threads | Catch up, one identical box,
// the pulse on a rise only, Catch up's long-press "Mark all as read".
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({ default: {} }));
vi.mock('@/lib/env', () => ({ env: {} }));
vi.mock('@/lib/supabase', () => ({
  supabase: { rpc: async () => ({ data: [], error: null }) },
}));

import {
  ACTIVITY_TOPBAR_BOX,
  CatchUpButton,
  MARK_ALL_AS_READ,
  PULSE_CYCLE_MS,
  PULSE_CYCLES,
  PULSE_QUIET_MS,
  ThreadsButton,
  TopbarActionsProvider,
  catchUpLabel,
  useTopbarActions,
  pulseRing,
  shouldPulse,
  threadsLabel,
} from '@/components/shell/topbar-actions';
import { TopbarSlots } from '@/components/shell/Topbar';
import { cn } from '@/lib/cn';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let reduce = false;
const animate = vi.fn(() => ({
  addEventListener: () => undefined,
  cancel: () => undefined,
  finish: () => undefined,
}));

beforeEach(() => {
  reduce = false;
  animate.mockClear();
  (HTMLElement.prototype as unknown as { animate: unknown }).animate = animate;
  window.matchMedia = ((query: string) => ({
    matches: reduce && query.includes('reduce'),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
});

async function mount(node: ReactElement): Promise<void> {
  if (root === null) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  }
  await act(async () => {
    root?.render(node);
  });
}

/** Moves played on the pulse ring itself (the count pill rolls its digits on its own). */
const ringPulses = (): number =>
  (animate.mock.contexts as unknown[]).filter(
    (el) => el instanceof HTMLElement && el.hasAttribute('data-topbar-pulse'),
  ).length;
const threads = (): HTMLElement | null => document.querySelector('[data-topbar-threads]');
const catchUp = (): HTMLElement | null => document.querySelector('[data-topbar-catch-up]');

describe('shouldPulse: only a rise, while on screen', () => {
  const base = { prev: 2, next: 3, armed: true, hidden: false, quiet: false };
  it('a rise pulses', () => expect(shouldPulse(base)).toBe(true));
  it('a fall or the same count never does', () => {
    expect(shouldPulse({ ...base, next: 1 })).toBe(false);
    expect(shouldPulse({ ...base, next: 2 })).toBe(false);
  });
  it('not on mount (no baseline yet), not unarmed, not hidden, not in the quiet window', () => {
    expect(shouldPulse({ ...base, prev: null })).toBe(false);
    expect(shouldPulse({ ...base, armed: false })).toBe(false);
    expect(shouldPulse({ ...base, hidden: true })).toBe(false);
    expect(shouldPulse({ ...base, quiet: true })).toBe(false);
  });
});

describe('the pulse ring', () => {
  it('3 cycles of 1.4 s, scale only, ends on the rest pose', () => {
    const el = document.createElement('span');
    expect(pulseRing(el)).not.toBeNull();
    expect(animate).toHaveBeenCalledTimes(1);
    const [frames, options] = animate.mock.calls[0] as unknown as [
      Keyframe[],
      KeyframeAnimationOptions,
    ];
    expect(PULSE_CYCLE_MS).toBe(1400);
    expect(options.duration).toBe(PULSE_CYCLE_MS * PULSE_CYCLES);
    for (const frame of frames) expect(Object.keys(frame).sort()).toEqual(['offset', 'transform']);
    expect(frames.filter((f) => f.transform === 'scale(1.15)')).toHaveLength(3);
  });

  it('reduced motion: nothing runs', () => {
    reduce = true;
    expect(pulseRing(document.createElement('span'))).toBeNull();
    expect(animate).not.toHaveBeenCalled();
  });

  it('a rise on screen pulses once; mount, a fall and the quiet window do not', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-10T09:00:00Z'));
    const open = vi.fn();
    await mount(<ThreadsButton count={1} armed onOpen={open} />);
    // Inside the quiet window after mount: a rise (a refresh landing) stays still.
    await mount(<ThreadsButton count={2} armed onOpen={open} />);
    expect(ringPulses()).toBe(0);
    vi.setSystemTime(Date.now() + PULSE_QUIET_MS + 1);
    await mount(<ThreadsButton count={1} armed onOpen={open} />);
    expect(ringPulses()).toBe(0);
    await mount(<ThreadsButton count={4} armed onOpen={open} />);
    expect(ringPulses()).toBe(1);
  });

  it('reduced motion: a rise does not pulse', async () => {
    reduce = true;
    vi.useFakeTimers({ toFake: ['Date'] });
    await mount(<ThreadsButton count={1} armed onOpen={() => undefined} />);
    vi.setSystemTime(Date.now() + PULSE_QUIET_MS + 1);
    await mount(<ThreadsButton count={5} armed onOpen={() => undefined} />);
    expect(ringPulses()).toBe(0);
  });
});

describe('one identical box', () => {
  it.each([0, 1, 150])('Threads and Catch up share the fixed box at %i', async (n) => {
    await mount(
      <span>
        <ThreadsButton count={n} armed={false} onOpen={() => undefined} />
        <CatchUpButton
          count={n}
          armed={false}
          onOpen={() => undefined}
          onMarkAllRead={() => undefined}
        />
      </span>,
    );
    const box = cn(ACTIVITY_TOPBAR_BOX).split(' ');
    for (const el of [threads(), catchUp()]) {
      const cls = (el?.className ?? '').split(/\s+/);
      for (const c of box) expect(cls).toContain(c);
      // One width: never min-w-0, never a second w-* class.
      expect(cls.filter((c) => /^w-/.test(c))).toEqual(['w-28']);
      expect(cls).toContain('h-11');
      expect(cls).toContain('rounded-lg');
    }
    const pill = document.querySelectorAll('[data-topbar-count]');
    if (n === 0) {
      expect(pill).toHaveLength(0);
      expect(threads()?.className).toContain('border-border-strong');
      expect(threads()?.className).not.toContain('bg-accent');
    } else {
      expect([...pill].map((p) => p.textContent)).toEqual([
        n > 99 ? '99+' : String(n),
        n > 99 ? '99+' : String(n),
      ]);
      expect(catchUp()?.className).toContain('bg-accent');
    }
  });

  it('aria: "Threads, N new" / "Threads"; "Catch up, N unread" / "Catch up"', () => {
    expect(threadsLabel(3)).toBe('Threads, 3 new');
    expect(threadsLabel(0)).toBe('Threads');
    expect(catchUpLabel(7)).toBe('Catch up, 7 unread');
    expect(catchUpLabel(0)).toBe('Catch up');
  });
});

describe('taps and the long-press', () => {
  it('a tap opens; at 0 it does nothing', async () => {
    const open = vi.fn();
    await mount(<ThreadsButton count={0} armed onOpen={open} />);
    act(() => threads()?.click());
    expect(open).not.toHaveBeenCalled();
    await mount(<ThreadsButton count={2} armed onOpen={open} />);
    act(() => threads()?.click());
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('Catch up at 0: greyed (aria-disabled), no action, the same box; above 0 it opens', async () => {
    const open = vi.fn();
    await mount(<CatchUpButton count={0} armed onOpen={open} onMarkAllRead={() => undefined} />);
    expect(catchUp()?.getAttribute('aria-disabled')).toBe('true');
    expect(catchUp()?.className).toContain('w-28');
    act(() => catchUp()?.click());
    expect(open).not.toHaveBeenCalled();
    expect(document.querySelector('[role="status"]')).toBeNull();
    await mount(<CatchUpButton count={3} armed onOpen={open} onMarkAllRead={() => undefined} />);
    expect(catchUp()?.hasAttribute('aria-disabled')).toBe(false);
    act(() => catchUp()?.click());
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('the count pill is CountBadge tone on-fill, no placement class', async () => {
    await mount(<ThreadsButton count={4} armed onOpen={() => undefined} />);
    const pill = threads()?.querySelector('[data-count-badge]');
    expect(pill?.getAttribute('data-count-badge')).toBe('on-fill');
    expect(pill?.className).toContain('bg-accent-fg');
    expect(pill?.className).toContain('text-accent');
  });

  it('phones: label hides, icon shows (icon + count, 56 wide)', async () => {
    await mount(<ThreadsButton count={4} armed onOpen={() => undefined} />);
    expect(threads()?.className).toContain('max-sm:w-14');
    expect(threads()?.querySelector('svg')?.getAttribute('class') ?? '').toContain('max-sm:block');
  });

  it('long-press Catch up: one row, Mark all as read, which marks all (no open)', async () => {
    vi.useFakeTimers();
    const open = vi.fn();
    const markAll = vi.fn();
    await mount(<CatchUpButton count={4} armed onOpen={open} onMarkAllRead={markAll} />);
    const button = catchUp();
    if (button === null) throw new Error('no button');
    act(() => {
      button.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, clientX: 5, clientY: 5 }),
      );
    });
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    act(() => {
      button.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      button.click();
    });
    expect(open).not.toHaveBeenCalled();
    const rows = [...document.querySelectorAll<HTMLElement>('[role="menuitem"], button')].filter(
      (b) => b.textContent?.includes(MARK_ALL_AS_READ),
    );
    expect(rows).toHaveLength(1);
    act(() => rows[0]?.click());
    expect(markAll).toHaveBeenCalledTimes(1);
  });

  it('right-click (laptop) opens the same menu', async () => {
    const markAll = vi.fn();
    await mount(<CatchUpButton count={0} armed onOpen={() => undefined} onMarkAllRead={markAll} />);
    act(() => {
      catchUp()?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    expect(document.body.textContent).toContain(MARK_ALL_AS_READ);
  });
});

describe('Topbar: the pair stands in place of the slots, on Activity only', () => {
  function Publish(props: { pair?: boolean }) {
    useTopbarActions(props.pair === true ? { pair: <i data-pair-probe="" /> } : { sort: null });
    return null;
  }
  it('a pair: no 44 slots, the pair 8 apart', async () => {
    await mount(
      <TopbarActionsProvider>
        <TopbarSlots />
        <Publish pair />
      </TopbarActionsProvider>,
    );
    expect(document.querySelectorAll('[data-topbar-slot]')).toHaveLength(0);
    const pair = document.querySelector('[data-topbar-pair]');
    expect(pair?.querySelector('[data-pair-probe]')).not.toBeNull();
    expect(pair?.className).toContain('gap-2');
  });
  it('no pair (every other screen): the two fixed slots, unchanged', async () => {
    await mount(
      <TopbarActionsProvider>
        <TopbarSlots />
        <Publish />
      </TopbarActionsProvider>,
    );
    expect(
      [...document.querySelectorAll('[data-topbar-slot]')].map((s) =>
        s.getAttribute('data-topbar-slot'),
      ),
    ).toEqual(['sort', 'primary']);
    expect(document.querySelector('[data-topbar-pair]')).toBeNull();
  });
});
