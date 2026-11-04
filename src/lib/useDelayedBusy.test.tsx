// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SKELETON_BUSY, SPINNER_BUSY, useDelayedBusy } from '@/lib/useDelayedBusy';
import type { DelayedBusyOptions } from '@/lib/useDelayedBusy';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let seen = false;

function Probe({ busy, options }: { busy: boolean; options: DelayedBusyOptions }): null {
  seen = useDelayedBusy(busy, options);
  return null;
}

const OPTS = { delay: 200, minVisible: 400 };

function render(busy: boolean, options: DelayedBusyOptions = OPTS): void {
  act(() => {
    if (root === null) root = createRoot(document.createElement('div'));
    root.render(<Probe busy={busy} options={options} />);
  });
}

function tick(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  seen = false;
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.useRealTimers();
});

describe('useDelayedBusy', () => {
  it('the shared settings: spinners 200/400, skeleton 150/300', () => {
    expect(SPINNER_BUSY).toEqual({ delay: 200, minVisible: 400 });
    expect(SKELETON_BUSY).toEqual({ delay: 150, minVisible: 300 });
  });

  it('never shows when busy ends before the delay (fast load)', () => {
    render(true);
    expect(seen).toBe(false);
    tick(199);
    expect(seen).toBe(false);
    render(false);
    tick(1000);
    expect(seen).toBe(false);
  });

  it('shows after the delay of continuous busy', () => {
    render(true);
    tick(199);
    expect(seen).toBe(false);
    tick(1);
    expect(seen).toBe(true);
  });

  it('a busy blip restarts the delay', () => {
    render(true);
    tick(150);
    render(false);
    render(true);
    tick(150);
    expect(seen).toBe(false);
    tick(50);
    expect(seen).toBe(true);
  });

  it('once shown, stays at least minVisible', () => {
    render(true);
    tick(200);
    expect(seen).toBe(true);
    tick(100);
    render(false);
    expect(seen).toBe(true);
    tick(299);
    expect(seen).toBe(true);
    tick(1);
    expect(seen).toBe(false);
  });

  it('hides at once when busy ends after minVisible already passed', () => {
    render(true);
    tick(200 + 400);
    render(false);
    expect(seen).toBe(false);
  });

  it('busy again during the hold keeps it shown with no gap', () => {
    render(true);
    tick(200);
    render(false);
    tick(100);
    render(true);
    tick(1000);
    expect(seen).toBe(true);
  });

  it('a zero delay shows on the first render', () => {
    render(true, { delay: 0, minVisible: 0 });
    expect(seen).toBe(true);
  });
});
