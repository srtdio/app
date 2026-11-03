// @vitest-environment jsdom
// The motion laws, move by move (docs/motion.md): every one of the nine moves
// and every small touch is (a) interruptible: any tap or key press finishes
// it; (b) instant under Reduce Motion and ?motion=0 (and the tab's
// sessionStorage memory of ?motion=0); (c) final state first: what a move lays
// over is already rendered at its end state, before the motion features load
// and with no Web Animations at all. And nothing ever animates opacity.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bellSwing,
  Bone,
  checkKeyframes,
  dialogIn,
  dialogOut,
  drawTick,
  dropIn,
  GlideItem,
  growBackIntoCard,
  growFromCard,
  growFromTrigger,
  itemIn,
  itemOut,
  MOVE_CLASS,
  motionOff,
  pop,
  pushBack,
  pushIn,
  pushSettle,
  resetMotionPreferenceForTests,
  resetPlayerForTests,
  riseIn,
  riseOut,
  rollDigit,
  runningCount,
  settle,
  shake,
  shrinkToTrigger,
  slideX,
  stepX,
  stripIn,
  stripOut,
  uploadSettle,
  usePresence,
  wipeAway,
  type MoveSpec,
  type Played,
} from '@/lib/motion';
import * as moves from '@/lib/motion/moves';
import * as touches from '@/lib/motion/touches';
import { guideNudge, handPress, handRipple } from '@/lib/motion/touches';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CARD = { left: 10, top: 20, width: 100, height: 60 };

/** Every JS move and touch, by name, run on one element. `settle` returns no Played. */
const RUNS: ReadonlyArray<readonly [string, (el: HTMLElement) => Played | void]> = [
  // 1. push
  ['push: pushIn', (el) => pushIn(el, document.createElement('div'))],
  ['push: pushBack', (el) => pushBack(el, document.createElement('div'), 20)],
  ['push: pushSettle', (el) => pushSettle(el, 40)],
  // 2. growFromCard
  ['growFromCard: growFromCard', (el) => growFromCard(el, CARD)],
  ['growFromCard: growBackIntoCard', (el) => growBackIntoCard(el, CARD)],
  // 3. rise
  ['rise: riseIn', (el) => riseIn(el)],
  ['rise: riseOut', (el) => riseOut(el, 30)],
  ['rise: dialogIn', (el) => dialogIn(el)],
  ['rise: dialogOut', (el) => dialogOut(el)],
  // 4. growFromTrigger
  ['growFromTrigger: growFromTrigger', (el) => growFromTrigger(el, 'top right')],
  ['growFromTrigger: shrinkToTrigger', (el) => shrinkToTrigger(el)],
  // 6. itemIn / itemOut
  ['itemIn', (el) => itemIn(el)],
  ['itemOut', (el) => itemOut(el)],
  // 8. edgeStrip
  ['edgeStrip: stripIn top', (el) => stripIn(el, 'top')],
  ['edgeStrip: stripOut bottom', (el) => stripOut(el, 'bottom')],
  ['edgeStrip: stripIn above the composer', (el) => stripIn(el, 'above-composer', 24)],
  ['edgeStrip: dropIn', (el) => dropIn(el)],
  // 9. sweepBoxes (settle on landing)
  ['sweepBoxes: settle', (el) => settle([el])],
  // Small touches
  ['touch: drawTick', (el) => drawTick(el)],
  ['touch: pop', (el) => pop(el)],
  ['touch: rollDigit', (el) => rollDigit(el, -1)],
  ['touch: shake', (el) => shake(el)],
  ['touch: bellSwing', (el) => bellSwing(el)],
  ['touch: wipeAway', (el) => wipeAway(el)],
  ['touch: slideX', (el) => slideX(el, 1)],
  ['touch: uploadSettle', (el) => uploadSettle(el)],
  ['touch: stepX next', (el) => stepX(el, 1)],
  ['touch: stepX back', (el) => stepX(el, -1)],
  ['touch: handPress', (el) => handPress(el)],
  ['touch: handRipple', (el) => handRipple(el)],
  ['touch: guideNudge', (el) => guideNudge(el)],
];

interface FakeAnimation {
  finish: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  addEventListener: (type: string, fn: () => void) => void;
  fire: (type: string) => void;
}

function fakeAnimation(): FakeAnimation {
  const listeners: Record<string, Array<() => void>> = {};
  const fire = (type: string): void => {
    for (const fn of listeners[type] ?? []) fn();
    listeners[type] = [];
  };
  return {
    finish: vi.fn(() => fire('finish')),
    cancel: vi.fn(() => fire('cancel')),
    addEventListener: (type, fn) => {
      (listeners[type] ??= []).push(fn);
    },
    fire,
  };
}

const animate = vi.fn((_frames: Keyframe[], _options?: KeyframeAnimationOptions) =>
  fakeAnimation(),
);
const proto = HTMLElement.prototype as { animate?: unknown };
const originalAnimate = proto.animate;
const originalMatchMedia = window.matchMedia;

function fakes(): FakeAnimation[] {
  return animate.mock.results.map((r) => r.value as FakeAnimation);
}

function reduceMotion(on: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: on && query === '(prefers-reduced-motion: reduce)',
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

function setUrl(search: string): void {
  window.history.replaceState(null, '', `/${search}`);
  resetMotionPreferenceForTests();
}

beforeEach(() => {
  animate.mockClear();
  proto.animate = animate;
  reduceMotion(false);
  setUrl('');
});

afterEach(() => {
  proto.animate = originalAnimate;
  window.matchMedia = originalMatchMedia;
  window.history.replaceState(null, '', '/');
  try {
    window.sessionStorage.clear();
  } catch {
    // ignore
  }
  resetMotionPreferenceForTests();
  resetPlayerForTests();
  document.body.innerHTML = '';
});

describe('(a) interrupt: any tap or key press finishes the move', () => {
  for (const [name, run] of RUNS) {
    it(`${name}: a pointerdown finishes it`, () => {
      const el = document.createElement('div');
      document.body.appendChild(el);
      run(el);
      expect(animate).toHaveBeenCalled();
      expect(runningCount()).toBeGreaterThan(0);
      document.dispatchEvent(new Event('pointerdown'));
      for (const animation of fakes()) expect(animation.finish).toHaveBeenCalled();
      expect(runningCount()).toBe(0);
    });
  }

  it('a key press finishes a move too, and the Played resolves', async () => {
    const el = document.createElement('div');
    const played = riseIn(el);
    expect(played.instant).toBe(false);
    document.dispatchEvent(new Event('keydown'));
    expect(fakes()[0]?.finish).toHaveBeenCalled();
    await expect(played.done).resolves.toBeUndefined();
  });

  it('the CSS press (move 5) is a :active scale that ignores disabled controls', () => {
    const css = readFileSync(fileURLToPath(new URL('../motion.css', import.meta.url)), 'utf8');
    expect(MOVE_CLASS.press).toBe('mv-press');
    expect(css).toMatch(
      /\.mv-press:active:not\(:disabled\):not\(\[aria-disabled='true'\]\)\s*\{\s*scale:\s*0\.97;/,
    );
  });
});

describe('(b) instant under Reduce Motion and ?motion=0', () => {
  function expectInstant(): void {
    for (const [name, run] of RUNS) {
      const el = document.createElement('div');
      const played = run(el);
      if (played !== undefined) expect(played.instant, name).toBe(true);
    }
    expect(animate).not.toHaveBeenCalled();
    expect(runningCount()).toBe(0);
  }

  it('Reduce Motion (prefers-reduced-motion: reduce): every move lands at once', () => {
    reduceMotion(true);
    expect(motionOff()).toBe(true);
    expectInstant();
  });

  it('?motion=0: every move lands at once', () => {
    setUrl('?motion=0');
    expect(motionOff()).toBe(true);
    expectInstant();
  });

  it('?motion=0 is remembered for the tab (sessionStorage) after the flag leaves the URL', () => {
    setUrl('?motion=0');
    expect(motionOff()).toBe(true);
    setUrl('');
    expect(motionOff()).toBe(true);
    expectInstant();
    setUrl('?motion=1');
    expect(motionOff()).toBe(false);
    setUrl('');
    expect(motionOff()).toBe(false);
  });

  it('the CSS moves collapse too (html[data-motion=off] and the media query)', () => {
    const css = readFileSync(fileURLToPath(new URL('../motion.css', import.meta.url)), 'utf8');
    expect(css).toContain("html[data-motion='off'] [class*='mv-']");
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });
});

describe('(c) final state first: rendered before the motion features load', () => {
  let root: Root | null = null;
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
  });

  function mount(node: ReactElement): HTMLElement {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root?.render(node);
    });
    return host;
  }

  function atRest(el: HTMLElement | null): void {
    expect(el).not.toBeNull();
    expect(el?.hidden).toBe(false);
    expect(el?.style.opacity ?? '').toBe('');
    expect(el?.style.transform ?? '').toBe('');
    expect(el?.style.visibility ?? '').toBe('');
  }

  it('glide: a GlideItem without MotionRoot is a plain element at its place', () => {
    const host = mount(createElement(GlideItem, { id: 'glide-probe' }, 'Row'));
    const el = host.querySelector<HTMLElement>('#glide-probe');
    atRest(el);
    expect(el?.textContent).toBe('Row');
  });

  it('sweepBoxes: a Bone is a box at its final size, swept (never faded or pulsing)', () => {
    const host = mount(createElement(Bone, { className: 'h-4 w-20' }));
    const bone = host.querySelector<HTMLElement>('[data-bone]');
    expect(bone).not.toBeNull();
    expect(bone?.className).toContain('mv-bone');
    expect(bone?.className).not.toMatch(/animate-|opacity|transition/);
    expect(bone?.style.opacity).toBe('');
  });

  it('rise: an open presence is mounted on the first render, at rest, with no Web Animations', () => {
    proto.animate = originalAnimate;
    function Panel(): ReactElement | null {
      const { rendered, ref } = usePresence<HTMLDivElement>(true, {
        enter: (el) => riseIn(el),
        exit: (el) => riseOut(el),
      });
      return rendered ? createElement('div', { ref, 'data-panel': '' }, 'Sheet body') : null;
    }
    const host = mount(createElement(Panel));
    atRest(host.querySelector<HTMLElement>('[data-panel]'));
  });

  for (const [name, run] of RUNS) {
    it(`${name}: with no Web Animations the element keeps its end state`, () => {
      proto.animate = originalAnimate;
      const el = document.createElement('div');
      const played = run(el);
      if (played !== undefined) expect(played.instant).toBe(true);
      atRest(el);
    });
  }
});

describe('never fade', () => {
  const specs = [...Object.entries(moves), ...Object.entries(touches)].filter(
    (entry): entry is [string, MoveSpec] =>
      typeof entry[1] === 'object' && entry[1] !== null && 'move' in entry[1],
  );

  it('checkKeyframes refuses opacity on every move spec', () => {
    expect(specs.length).toBeGreaterThanOrEqual(9);
    for (const [name, spec] of specs) {
      expect(() => checkKeyframes(spec, [{ opacity: 0 }, { opacity: 1 }]), name).toThrow(/opacity/);
    }
  });

  it('no move or touch ever sends opacity to Web Animations', () => {
    for (const [, run] of RUNS) run(document.createElement('div'));
    for (const call of animate.mock.calls) {
      const frames = call[0];
      expect(frames.some((frame) => 'opacity' in frame)).toBe(false);
    }
  });
});
