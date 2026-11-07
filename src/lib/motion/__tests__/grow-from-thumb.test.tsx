// @vitest-environment jsdom
// D2: a media viewer grows ONLY its media out of the thumbnail. With no media
// element (none asked for, or not mounted yet: spinner, error card) nothing
// animates, so the viewer root (its arrows and bars) can never sit at the
// bubble's size. The grow runs fill none and is cancelled on unmount.
import { act, useRef } from 'react';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { growTarget, useGrowFromThumb } from '@/lib/motion/overlays';
import { resetMotionPreferenceForTests, resetPlayerForTests } from '@/lib/motion';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface FakeAnimation {
  el: Element;
  options: KeyframeAnimationOptions;
  finish: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  addEventListener: (type: string, cb: () => void) => void;
}

const animations: FakeAnimation[] = [];

function giveAnimate(): void {
  Object.defineProperty(HTMLElement.prototype, 'animate', {
    configurable: true,
    writable: true,
    value: function animate(
      this: Element,
      _frames: Keyframe[],
      options: KeyframeAnimationOptions,
    ): FakeAnimation {
      const listeners: Record<string, Array<() => void>> = {};
      const fire = (type: string): void => {
        for (const cb of listeners[type] ?? []) cb();
        listeners[type] = [];
      };
      const animation: FakeAnimation = {
        el: this,
        options,
        finish: vi.fn(() => fire('finish')),
        cancel: vi.fn(() => fire('cancel')),
        addEventListener: (type, cb) => {
          (listeners[type] ??= []).push(cb);
        },
      };
      animations.push(animation);
      return animation;
    },
  });
}

const BOX = { left: 10, top: 20, width: 120, height: 90 };

function Viewer(props: {
  withImage: boolean;
  target?: ((root: HTMLDivElement) => Element | null) | undefined;
}): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  useGrowFromThumb(ref, BOX, props.target);
  return (
    <div ref={ref} role="dialog" data-root="">
      <div data-lightbox-pane="">
        {props.withImage ? <img alt="photo" src="blob:x" /> : <span data-spinner="" />}
      </div>
      <button type="button" aria-label="Previous image" />
    </div>
  );
}

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(node: ReactElement): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(node));
}

beforeEach(() => {
  animations.length = 0;
  resetPlayerForTests();
  window.history.replaceState({}, '', '/');
  resetMotionPreferenceForTests();
  giveAnimate();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  delete (HTMLElement.prototype as { animate?: unknown }).animate;
  resetPlayerForTests();
});

const imageOnly = (r: HTMLDivElement): Element | null =>
  r.querySelector('[data-lightbox-pane] img');

describe('growTarget (pure)', () => {
  it('no root or no target picker: null (never the root)', () => {
    const el = document.createElement('div');
    expect(growTarget(null, () => el)).toBeNull();
    expect(growTarget(el, undefined)).toBeNull();
  });

  it('a picker that finds nothing, or returns the root itself: null', () => {
    const el = document.createElement('div');
    expect(growTarget(el, () => null)).toBeNull();
    expect(growTarget(el, (r) => r)).toBeNull();
  });

  it('a picker that finds the media: that element', () => {
    const el = document.createElement('div');
    const img = document.createElement('img');
    el.appendChild(img);
    expect(growTarget(el, (r) => r.querySelector('img'))).toBe(img);
  });
});

describe('useGrowFromThumb', () => {
  it('no target picker: nothing animates (the root never grows)', () => {
    render(<Viewer withImage />);
    expect(animations).toHaveLength(0);
  });

  it('the image is not mounted yet: nothing animates, not the root, not the pane', () => {
    render(<Viewer withImage={false} target={imageOnly} />);
    expect(animations).toHaveLength(0);
  });

  it('the image is mounted: only the image grows, with fill none', () => {
    render(<Viewer withImage target={imageOnly} />);
    expect(animations).toHaveLength(1);
    const grow = animations[0] as FakeAnimation;
    expect(grow.el.tagName).toBe('IMG');
    expect(grow.el.closest('[data-root]')).not.toBeNull();
    expect((grow.options.fill ?? 'none') === 'none').toBe(true);
  });

  it('unmount mid-grow cancels the move, so no thumbnail transform is held', () => {
    render(<Viewer withImage target={imageOnly} />);
    const grow = animations[0] as FakeAnimation;
    act(() => root?.unmount());
    root = null;
    expect(grow.cancel).toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
