// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  prefersReducedMotion: () => false,
}));

import { centredTop, FOCUS_SETTLE_MS, FOCUS_WAIT_MS, useFocusTarget } from '@/lib/focus-target';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

interface Spies {
  onMissing: ReturnType<typeof vi.fn>;
  highlight: ReturnType<typeof vi.fn>;
  untint: ReturnType<typeof vi.fn>;
}

function Probe(props: {
  id: string | null;
  absent?: boolean;
  spies: Spies;
  runKey?: string;
}): null {
  useFocusTarget({
    targetId: props.id,
    ...(props.runKey !== undefined ? { targetKey: props.runKey } : {}),
    findElement: (id) => document.getElementById(`row-${id}`),
    ...(props.absent !== undefined ? { absent: props.absent } : {}),
    onMissing: props.spies.onMissing,
    highlight: props.spies.highlight,
  });
  return null;
}

function spies(): Spies {
  const untint = vi.fn();
  return { onMissing: vi.fn(), highlight: vi.fn(() => untint), untint };
}

function render(id: string | null, s: Spies, absent?: boolean): void {
  act(() => {
    root?.render(<Probe id={id} spies={s} {...(absent !== undefined ? { absent } : {})} />);
  });
}

function addRow(id: string): HTMLElement {
  const el = document.createElement('div');
  el.id = `row-${id}`;
  document.body.appendChild(el);
  return el;
}

beforeEach(() => {
  vi.useFakeTimers();
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('useFocusTarget', () => {
  it('lands on a row that is already rendered', () => {
    const s = spies();
    const el = addRow('a');
    render('a', s);
    expect(s.highlight).toHaveBeenCalledTimes(1);
    expect(s.highlight).toHaveBeenCalledWith(el);
    expect(window.scrollTo).toHaveBeenCalled();
    expect(s.onMissing).not.toHaveBeenCalled();
  });

  it('waits for a row that renders late (skeleton, slow read, slide in)', async () => {
    const s = spies();
    render('a', s);
    expect(s.highlight).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3000);
    const el = addRow('a');
    // MutationObserver callbacks run as microtasks.
    await act(async () => {
      await Promise.resolve();
    });
    expect(s.highlight).toHaveBeenCalledWith(el);
    vi.advanceTimersByTime(FOCUS_WAIT_MS);
    expect(s.onMissing).not.toHaveBeenCalled();
  });

  it('a row that never renders calls onMissing once, at the timeout', () => {
    const s = spies();
    render('gone', s);
    vi.advanceTimersByTime(FOCUS_WAIT_MS - 1);
    expect(s.onMissing).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(s.onMissing).toHaveBeenCalledTimes(1);
    expect(s.onMissing).toHaveBeenCalledWith('gone');
    vi.advanceTimersByTime(FOCUS_WAIT_MS * 2);
    render('gone', s);
    expect(s.onMissing).toHaveBeenCalledTimes(1);
  });

  it('a known-absent target reports missing at once, once', () => {
    const s = spies();
    render('gone', s, false);
    render('gone', s, true);
    expect(s.onMissing).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(FOCUS_WAIT_MS);
    expect(s.onMissing).toHaveBeenCalledTimes(1);
  });

  it('a new id runs again and ends the previous tint', () => {
    const s = spies();
    addRow('a');
    const b = addRow('b');
    render('a', s);
    render('b', s);
    expect(s.highlight).toHaveBeenCalledTimes(2);
    expect(s.highlight).toHaveBeenLastCalledWith(b);
    expect(s.untint).toHaveBeenCalledTimes(1);
  });

  it('the same id twice in one mount does not run again', () => {
    const s = spies();
    addRow('a');
    render('a', s);
    render(null, s);
    render('a', s);
    expect(s.highlight).toHaveBeenCalledTimes(1);
  });

  it('the same id with a fresh targetKey lands again (a second tap on one comment)', () => {
    const s = spies();
    addRow('a');
    act(() => root?.render(<Probe id="a" runKey="tap-1" spies={s} />));
    act(() => root?.render(<Probe id="a" runKey="tap-1" spies={s} />));
    expect(s.highlight).toHaveBeenCalledTimes(1);
    act(() => root?.render(<Probe id="a" runKey="tap-2" spies={s} />));
    expect(s.highlight).toHaveBeenCalledTimes(2);
  });

  it('keeps the row in place when content loads above it, until the settle window ends', async () => {
    const s = spies();
    const row = addRow('a');
    let top = 500;
    row.getBoundingClientRect = () => ({ top, height: 40 }) as DOMRect;
    const scrollTo = window.scrollTo as unknown as ReturnType<typeof vi.fn>;
    render('a', s);
    const landings = scrollTo.mock.calls.length;
    // The landing scroll's resting place is taken, then rows load above.
    act(() => vi.advanceTimersByTime(500));
    top = 800;
    await act(async () => {
      document.body.appendChild(document.createElement('div'));
      await Promise.resolve();
    });
    act(() => vi.advanceTimersByTime(50));
    expect(scrollTo.mock.calls.length).toBeGreaterThan(landings + 1);
    // After the settle window nothing re-scrolls.
    act(() => vi.advanceTimersByTime(FOCUS_SETTLE_MS));
    const settled = scrollTo.mock.calls.length;
    top = 1200;
    await act(async () => {
      document.body.appendChild(document.createElement('div'));
      await Promise.resolve();
    });
    act(() => vi.advanceTimersByTime(50));
    expect(scrollTo.mock.calls.length).toBe(settled);
  });

  it('a touch hands the scroll back: no re-centre after it', async () => {
    const s = spies();
    const row = addRow('a');
    let top = 500;
    row.getBoundingClientRect = () => ({ top, height: 40 }) as DOMRect;
    const scrollTo = window.scrollTo as unknown as ReturnType<typeof vi.fn>;
    render('a', s);
    act(() => vi.advanceTimersByTime(500));
    act(() => {
      window.dispatchEvent(new Event('pointerdown'));
    });
    const after = scrollTo.mock.calls.length;
    top = 900;
    await act(async () => {
      document.body.appendChild(document.createElement('div'));
      await Promise.resolve();
    });
    act(() => vi.advanceTimersByTime(50));
    expect(scrollTo.mock.calls.length).toBe(after);
  });

  it('unmount clears the wait (no late onMissing) and the tint', () => {
    const s = spies();
    render('late', s);
    act(() => root?.unmount());
    root = null;
    vi.advanceTimersByTime(FOCUS_WAIT_MS * 2);
    expect(s.onMissing).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const t = spies();
    addRow('a');
    render('a', t);
    act(() => root?.unmount());
    root = null;
    expect(t.untint).toHaveBeenCalledTimes(1);
  });
});

describe('centredTop', () => {
  it('centres the row in its scroller', () => {
    expect(
      centredTop({
        scrollTop: 100,
        viewTop: 0,
        viewHeight: 600,
        elTop: 900,
        elHeight: 100,
        marginTop: 0,
        marginBottom: 0,
      }),
    ).toBe(100 + 900 - 250);
  });

  it('keeps the row centred in the room above a sticky bottom bar', () => {
    expect(
      centredTop({
        scrollTop: 0,
        viewTop: 0,
        viewHeight: 600,
        elTop: 900,
        elHeight: 100,
        marginTop: 0,
        marginBottom: 100,
      }),
    ).toBe(900 - 200);
  });

  it('never scrolls above the top', () => {
    expect(
      centredTop({
        scrollTop: 0,
        viewTop: 0,
        viewHeight: 600,
        elTop: 10,
        elHeight: 50,
        marginTop: 0,
        marginBottom: 0,
      }),
    ).toBe(0);
  });
});
