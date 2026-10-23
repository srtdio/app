// @vitest-environment jsdom
// The bottom Undo strip: label + Undo button only (no X, no countdown, no
// icon), a polite status region, Undo runs the action, a swipe down past 40%
// of its height accepts (commit now) while a short one snaps back, and the
// viewport routes kind 'undo' toasts to the strip, never the top card.
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  STRIP_ANCHOR_GAP_PX,
  STRIP_SWIPE_ACCEPT_RATIO,
  UNDO_ANCHOR_ATTR,
  UNDO_STRIP_KEYFRAMES,
  UndoStrip,
  stripBottomPx,
  swipeAccepts,
} from '@/components/ui/toast/UndoStrip';
import { ToastProvider, ToastViewport, useToast } from '@/components/ui/toast/ToastProvider';
import type { Toast as ToastModel, ToastApi } from '@/components/ui/toast/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STRIP_HEIGHT = 50;

let root: Root | null = null;
let restoreOffsetHeight: (() => void) | null = null;

function render(node: ReactElement): void {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(node));
}

// jsdom does no layout: give every element the strip's 50px height so the
// swipe threshold has something to measure against.
function stubOffsetHeight(px: number): void {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => px,
  });
  restoreOffsetHeight = () => {
    if (original !== undefined) {
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', original);
    }
  };
}

function pointer(target: Element, type: string, clientY: number): void {
  const init = { bubbles: true, cancelable: true, clientY, pointerId: 1 };
  const event =
    typeof PointerEvent === 'function' ? new PointerEvent(type, init) : new MouseEvent(type, init);
  act(() => {
    target.dispatchEvent(event);
  });
}

/** Press on the label, move down by `dy` in a few steps, release. */
function swipe(strip: Element, dy: number): void {
  const label = strip.querySelector('span');
  if (label === null) throw new Error('strip has no label');
  pointer(label, 'pointerdown', 100);
  pointer(label, 'pointermove', 100 + dy / 2);
  pointer(label, 'pointermove', 100 + dy);
  pointer(label, 'pointerup', 100 + dy);
}

function strip(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-undo-strip]');
  if (el === null) throw new Error('no strip');
  return el;
}

const undoToast: ToastModel = {
  id: '7',
  title: 'Post deleted',
  kind: 'undo',
  action: { label: 'Undo', onPress: () => {} },
};

beforeEach(() => {
  stubOffsetHeight(STRIP_HEIGHT);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  restoreOffsetHeight?.();
  restoreOffsetHeight = null;
  document.body.innerHTML = '';
});

describe('UndoStrip', () => {
  it('renders the label and an Undo button, nothing else', () => {
    render(<UndoStrip toast={undoToast} onAccept={() => {}} onAction={() => {}} />);
    const el = strip();
    expect(el.textContent).toContain('Post deleted');
    const buttons = el.querySelectorAll('button');
    expect(buttons).toHaveLength(1);
    const undo = buttons[0]!;
    expect(undo.textContent).toBe('Undo');
    expect(undo.hasAttribute('data-toast-action')).toBe(true);
    expect(undo.getAttribute('type')).toBe('button');
    // 44px touch target.
    expect(undo.className).toContain('min-h-[44px]');
    expect(undo.className).toContain('min-w-[44px]');
    // No X, no countdown bar, no icon.
    expect(el.querySelector('[aria-label="Dismiss notification"]')).toBeNull();
    expect(el.querySelector('[data-toast-countdown]')).toBeNull();
    expect(el.innerHTML).not.toContain('countdown');
    expect(el.querySelector('svg')).toBeNull();
    // Undo is the last child, after the label.
    expect(el.lastElementChild).toBe(undo);
  });

  it('is a polite status region marked data-undo-strip', () => {
    render(<UndoStrip toast={undoToast} onAccept={() => {}} onAction={() => {}} />);
    const el = strip();
    expect(el.getAttribute('role')).toBe('status');
    expect(el.getAttribute('aria-live')).toBe('polite');
    expect(el.hasAttribute('data-undo-strip')).toBe(true);
    expect(el.hasAttribute('data-leaving')).toBe(false);
  });

  it('renders no button when the toast has no action', () => {
    const bare: ToastModel = { id: '7', title: 'Post deleted', kind: 'undo' };
    render(<UndoStrip toast={bare} onAccept={() => {}} onAction={() => {}} />);
    expect(strip().querySelectorAll('button')).toHaveLength(0);
    expect(strip().textContent).toBe('Post deleted');
  });

  it('Undo calls onAction with the id, never onAccept', () => {
    const onAction = vi.fn();
    const onAccept = vi.fn();
    render(<UndoStrip toast={undoToast} onAccept={onAccept} onAction={onAction} />);
    act(() => {
      strip().querySelector('button')!.click();
    });
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith('7');
    expect(onAccept).not.toHaveBeenCalled();
  });

  it('a swipe down past 40% of its height accepts', () => {
    const onAccept = vi.fn();
    render(<UndoStrip toast={undoToast} onAccept={onAccept} onAction={() => {}} />);
    swipe(strip(), STRIP_HEIGHT * STRIP_SWIPE_ACCEPT_RATIO);
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onAccept).toHaveBeenCalledWith('7');
  });

  it('a longer swipe accepts too', () => {
    const onAccept = vi.fn();
    render(<UndoStrip toast={undoToast} onAccept={onAccept} onAction={() => {}} />);
    swipe(strip(), STRIP_HEIGHT);
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it('a small swipe snaps back without accepting', () => {
    const onAccept = vi.fn();
    render(<UndoStrip toast={undoToast} onAccept={onAccept} onAction={() => {}} />);
    swipe(strip(), STRIP_HEIGHT * STRIP_SWIPE_ACCEPT_RATIO - 1);
    expect(onAccept).not.toHaveBeenCalled();
    // A later full swipe still works (the drag reset to 0).
    swipe(strip(), STRIP_HEIGHT);
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it('a swipe up never accepts', () => {
    const onAccept = vi.fn();
    render(<UndoStrip toast={undoToast} onAccept={onAccept} onAction={() => {}} />);
    swipe(strip(), -STRIP_HEIGHT * 2);
    expect(onAccept).not.toHaveBeenCalled();
  });

  it('a drag that starts on the Undo button is not a swipe', () => {
    const onAccept = vi.fn();
    render(<UndoStrip toast={undoToast} onAccept={onAccept} onAction={() => {}} />);
    const button = strip().querySelector('button')!;
    pointer(button, 'pointerdown', 100);
    pointer(button, 'pointermove', 100 + STRIP_HEIGHT);
    pointer(button, 'pointerup', 100 + STRIP_HEIGHT);
    expect(onAccept).not.toHaveBeenCalled();
  });

  it('while leaving: marked data-leaving and swipes are ignored', () => {
    const onAccept = vi.fn();
    render(<UndoStrip toast={undoToast} leaving onAccept={onAccept} onAction={() => {}} />);
    expect(strip().hasAttribute('data-leaving')).toBe(true);
    swipe(strip(), STRIP_HEIGHT);
    expect(onAccept).not.toHaveBeenCalled();
  });

  it('on phone sits STRIP_ANCHOR_GAP_PX above a visible anchor', () => {
    const anchor = document.createElement('nav');
    anchor.setAttribute(UNDO_ANCHOR_ATTR, '');
    anchor.getBoundingClientRect = () =>
      ({
        top: 700,
        bottom: 768,
        left: 0,
        right: 390,
        width: 390,
        height: 68,
        x: 0,
        y: 700,
      }) as DOMRect;
    document.body.appendChild(anchor);
    render(<UndoStrip toast={undoToast} onAccept={() => {}} onAction={() => {}} />);
    const expected = stripBottomPx([700], window.innerHeight);
    expect(strip().style.getPropertyValue('--strip-bottom')).toBe(`${expected}px`);
  });
});

describe('stripBottomPx', () => {
  it('is null with no anchors (CSS falls back above the safe area)', () => {
    expect(stripBottomPx([], 800)).toBeNull();
  });

  it('sits the gap above the anchor', () => {
    expect(STRIP_ANCHOR_GAP_PX).toBe(8);
    expect(stripBottomPx([744], 844)).toBe(100 + STRIP_ANCHOR_GAP_PX);
  });

  it('uses the highest anchor when there are several', () => {
    expect(stripBottomPx([744, 600, 700], 844)).toBe(244 + STRIP_ANCHOR_GAP_PX);
  });

  it('never goes below the gap for an anchor at or past the bottom edge', () => {
    expect(stripBottomPx([844], 844)).toBe(STRIP_ANCHOR_GAP_PX);
    expect(stripBottomPx([900], 844)).toBe(STRIP_ANCHOR_GAP_PX);
  });
});

describe('swipeAccepts', () => {
  it('accepts at and past 40% of the height', () => {
    expect(STRIP_SWIPE_ACCEPT_RATIO).toBe(0.4);
    expect(swipeAccepts(20, 50)).toBe(true);
    expect(swipeAccepts(49, 50)).toBe(true);
    expect(swipeAccepts(200, 50)).toBe(true);
  });

  it('rejects below 40%, no drag, and an unmeasured strip', () => {
    expect(swipeAccepts(19.9, 50)).toBe(false);
    expect(swipeAccepts(0, 50)).toBe(false);
    expect(swipeAccepts(-30, 50)).toBe(false);
    expect(swipeAccepts(100, 0)).toBe(false);
  });
});

describe('UNDO_STRIP_KEYFRAMES', () => {
  it('moves on translateY only and fades only under reduced motion', () => {
    expect(UNDO_STRIP_KEYFRAMES).toContain('@keyframes sorted-strip-in');
    expect(UNDO_STRIP_KEYFRAMES).toContain('@keyframes sorted-strip-out');
    expect(UNDO_STRIP_KEYFRAMES).not.toMatch(/translateX|scale|rotate/);
    expect(UNDO_STRIP_KEYFRAMES).toContain('prefers-reduced-motion: reduce');
  });
});

describe('ToastViewport', () => {
  let api: ToastApi | null = null;

  function Grab(): null {
    api = useToast();
    return null;
  }

  beforeEach(() => {
    api = null;
    render(
      <ToastProvider>
        <Grab />
        <ToastViewport />
      </ToastProvider>,
    );
  });

  // The top card container: the polite region that is not the strip.
  function topContainer(): HTMLElement {
    const el = [...document.querySelectorAll<HTMLElement>('[role="status"]')].find(
      (node) => !node.hasAttribute('data-undo-strip'),
    );
    if (el === undefined) throw new Error('no top container');
    return el;
  }

  it('puts an undo toast in the bottom strip, not the top card stack', () => {
    act(() => {
      api?.show({
        title: 'Post deleted',
        kind: 'undo',
        durationMs: 0,
        action: { label: 'Undo', onPress: () => {} },
      });
    });
    expect(strip().textContent).toContain('Post deleted');
    expect(topContainer().textContent).not.toContain('Post deleted');
    expect(document.querySelector('[aria-label="Dismiss notification"]')).toBeNull();
  });

  it('keeps a plain toast as a top card with its X', () => {
    act(() => {
      api?.show({ title: 'Saved', durationMs: 0 });
    });
    expect(topContainer().textContent).toContain('Saved');
    expect(topContainer().querySelector('[aria-label="Dismiss notification"]')).not.toBeNull();
    expect(document.querySelector('[data-undo-strip]')).toBeNull();
  });

  it('shows one strip at a time: a second undo toast replaces the first', () => {
    const first = vi.fn();
    act(() => {
      api?.show({ title: 'First', kind: 'undo', durationMs: 0, onExpire: first });
    });
    act(() => {
      api?.show({ title: 'Second', kind: 'undo', durationMs: 0 });
    });
    expect(first).toHaveBeenCalledTimes(1);
    const live = document.querySelectorAll('[data-undo-strip]:not([data-leaving])');
    expect(live).toHaveLength(1);
    expect(live[0]!.textContent).toContain('Second');
  });

  it('Undo in the strip runs the action and never onExpire', () => {
    const onPress = vi.fn();
    const onExpire = vi.fn();
    act(() => {
      api?.show({
        title: 'Post deleted',
        kind: 'undo',
        durationMs: 0,
        action: { label: 'Undo', onPress },
        onExpire,
      });
    });
    act(() => {
      strip().querySelector('button')!.click();
    });
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onExpire).not.toHaveBeenCalled();
    expect(strip().hasAttribute('data-leaving')).toBe(true);
  });

  it('a swipe down in the strip accepts: onExpire once', () => {
    const onExpire = vi.fn();
    act(() => {
      api?.show({ title: 'Post deleted', kind: 'undo', durationMs: 0, onExpire });
    });
    swipe(strip(), STRIP_HEIGHT);
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(strip().hasAttribute('data-leaving')).toBe(true);
  });
});
