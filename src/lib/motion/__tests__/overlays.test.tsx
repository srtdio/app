// @vitest-environment jsdom
// Overlays on the motion module (G3): the Sheet renders at its final state on
// the first frame and lays the rise over it; an exit unmounts at once when
// motion is instant; ?motion=0 turns every move off (no Web Animation at all);
// and any tap finishes a running move.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sheet } from '@/components/ui/Sheet';
import { resetMotionPreferenceForTests, resetPlayerForTests, runningCount } from '@/lib/motion';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface FakeAnimation {
  finish: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  addEventListener: (type: string, cb: () => void) => void;
}

/** A stand-in for a running Web Animation: finish() fires its 'finish' listeners. */
function fakeAnimation(): FakeAnimation {
  const listeners: Record<string, Array<() => void>> = {};
  const fire = (type: string): void => {
    const list = listeners[type] ?? [];
    listeners[type] = [];
    for (const cb of list) cb();
  };
  return {
    finish: vi.fn(() => fire('finish')),
    cancel: vi.fn(() => fire('cancel')),
    addEventListener: (type, cb) => {
      (listeners[type] ??= []).push(cb);
    },
  };
}

const animations: FakeAnimation[] = [];
const animate = vi.fn(() => {
  const animation = fakeAnimation();
  animations.push(animation);
  return animation;
});

function giveAnimate(): void {
  Object.defineProperty(HTMLElement.prototype, 'animate', {
    configurable: true,
    writable: true,
    value: animate,
  });
}

function takeAnimate(): void {
  delete (HTMLElement.prototype as { animate?: unknown }).animate;
}

function setSearch(search: string): void {
  window.history.replaceState({}, '', `/${search}`);
  try {
    window.sessionStorage.clear();
  } catch {
    // ignore
  }
  resetMotionPreferenceForTests();
}

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(open: boolean): void {
  if (host === null) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  }
  act(() => {
    root?.render(
      <Sheet open={open} onClose={() => undefined} title="New post">
        <p>body</p>
      </Sheet>,
    );
  });
}

const panel = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="dialog"]');

beforeEach(() => {
  animate.mockClear();
  animations.length = 0;
  resetPlayerForTests();
  setSearch('');
  if (typeof window.requestAnimationFrame !== 'function') {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16));
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
  }
});

afterEach(() => {
  for (const animation of animations) animation.finish();
  act(() => root?.unmount());
  root = null;
  host = null;
  document.body.innerHTML = '';
  takeAnimate();
  resetPlayerForTests();
  setSearch('');
  vi.unstubAllGlobals();
});

describe('Sheet on the motion module', () => {
  it('open renders the panel at once, at its final state (no opacity, transition or offscreen class)', () => {
    render(true);
    const el = panel();
    expect(el).not.toBeNull();
    expect(el?.className).not.toMatch(/opacity-|transition|duration-|translate-y-full|translate-y-2/);
    expect(el?.parentElement?.className).not.toMatch(/opacity-|transition|duration-/);
    // The dim is the scrim at full strength; nothing waits for a frame to show it.
    const dim = document.querySelector<HTMLElement>('[data-sheet-dim]');
    expect(dim?.className).toContain('bg-scrim');
    expect(dim?.style.opacity).toBe('');
  });

  it('exit unmounts in the same commit when motion is instant (no Web Animations)', () => {
    takeAnimate();
    render(true);
    expect(panel()).not.toBeNull();
    render(false);
    expect(panel()).toBeNull();
  });

  it('with motion on, the panel rises from 100% on the first frame (a Web Animation, never opacity)', () => {
    giveAnimate();
    render(true);
    expect(animate).toHaveBeenCalled();
    const [frames] = animate.mock.calls[0] as unknown as [Keyframe[]];
    expect(frames[0]?.transform).toBe('translateY(100%)');
    expect(frames[frames.length - 1]?.transform).toBe('translateY(0)');
    for (const frame of frames) expect(frame).not.toHaveProperty('opacity');
  });

  it('?motion=0 makes the sheet instant: no animate call on open or close', () => {
    giveAnimate();
    setSearch('?motion=0');
    render(true);
    expect(panel()).not.toBeNull();
    render(false);
    expect(panel()).toBeNull();
    expect(animate).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem('sorted.motion')).toBe('0');
  });

  it('a tap during a running move finishes it (pointerdown calls finish())', async () => {
    giveAnimate();
    render(true);
    const rise = animations[0];
    expect(rise).toBeDefined();
    expect(runningCount()).toBeGreaterThan(0);
    act(() => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(rise?.finish).toHaveBeenCalled();
    expect(runningCount()).toBe(0);
  });

  it('a close with motion on stays mounted through the exit, and a tap ends it at once', async () => {
    giveAnimate();
    render(true);
    for (const animation of animations) animation.finish();
    render(false);
    // The exit (riseOut) is running: the panel stays until it ends.
    expect(panel()).not.toBeNull();
    const exit = animations[animations.length - 1];
    await act(async () => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      await Promise.resolve();
    });
    expect(exit?.finish).toHaveBeenCalled();
    expect(panel()).toBeNull();
  });
});
