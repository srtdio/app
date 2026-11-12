// @vitest-environment jsdom
// ui/WritingBox reveal: a box taller than half the visible band lifts its
// bottom row only while the caret is at the end of the text; a selected range
// or a finger down on the box never scrolls; a short box keeps
// scrollIntoView nearest plus the lift above the keyboard.
import { act, useRef, useState, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WritingBox } from '@/components/ui/WritingBox';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let boxHeight = 300;
const observers: (() => void)[] = [];
let vv: EventTarget & { height: number; offsetTop: number; width: number };
let scrollBy: ReturnType<typeof vi.fn>;
let intoView: ReturnType<typeof vi.fn>;

class FakeRO {
  private readonly cb: () => void;
  constructor(cb: () => void) {
    this.cb = cb;
  }
  observe(): void {
    observers.push(this.cb);
  }
  disconnect(): void {
    const i = observers.indexOf(this.cb);
    if (i >= 0) observers.splice(i, 1);
  }
  unobserve(): void {}
}

beforeEach(() => {
  boxHeight = 300;
  observers.length = 0;
  // Keyboard up: 800 tall window, 400 visible.
  vv = Object.assign(new EventTarget(), { height: 400, offsetTop: 0, width: 390 });
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
  vi.stubGlobal('ResizeObserver', FakeRO);
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
  scrollBy = vi.fn();
  window.scrollBy = scrollBy as unknown as typeof window.scrollBy;
  intoView = vi.fn();
  Element.prototype.scrollIntoView = intoView as unknown as Element['scrollIntoView'];
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const top = 600 - boxHeight;
    return {
      top,
      bottom: 600,
      height: boxHeight,
      left: 0,
      right: 390,
      width: 390,
      x: 0,
      y: top,
      toJSON: () => ({}),
    } as DOMRect;
  });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const LONG = Array.from({ length: 60 }, (_, i) => `caption line ${i}`).join('\n');

function Harness(props: { initial: string }): ReactElement {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const [text, setText] = useState(props.initial);
  return (
    <WritingBox
      mode="caption"
      laptop={false}
      field={() => ref.current}
      hasText={text !== ''}
      input={
        <textarea
          ref={ref}
          aria-label="Caption"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      }
    />
  );
}

function open(initial: string, caret: number | [number, number]): HTMLTextAreaElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(<Harness initial={initial} />));
  const area = host.querySelector('textarea') as HTMLTextAreaElement;
  const [s, e] = typeof caret === 'number' ? [caret, caret] : caret;
  area.setSelectionRange(s, e);
  scrollBy.mockClear();
  intoView.mockClear();
  act(() => area.focus());
  return area;
}

function nudge(): void {
  act(() => {
    vv.dispatchEvent(new Event('resize'));
    for (const cb of [...observers]) cb();
  });
}

describe('WritingBox reveal', () => {
  it('tall box, caret mid-text: no scroll on focus, keyboard resize or box resize', () => {
    open(LONG, 200);
    nudge();
    expect(scrollBy).not.toHaveBeenCalled();
    expect(intoView).not.toHaveBeenCalled();
  });

  it('tall box, caret at the end: the bottom row is lifted over the keyboard', () => {
    open(LONG, LONG.length);
    // bottom 600 - visible 400 + 12 gap.
    expect(scrollBy).toHaveBeenCalledWith(0, 212);
    expect(intoView).not.toHaveBeenCalled();
  });

  it('a selected range never scrolls', () => {
    open(LONG, [100, LONG.length]);
    nudge();
    expect(scrollBy).not.toHaveBeenCalled();
    boxHeight = 100;
    nudge();
    expect(scrollBy).not.toHaveBeenCalled();
    expect(intoView).not.toHaveBeenCalled();
  });

  it('a pointer or touch down on the box never scrolls; lifting it allows again', () => {
    const area = open(LONG, LONG.length);
    scrollBy.mockClear();
    const box = document.querySelector('[data-writing-box]') as HTMLElement;
    act(() => box.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    nudge();
    expect(scrollBy).not.toHaveBeenCalled();
    act(() => window.dispatchEvent(new Event('pointerup')));
    act(() => box.dispatchEvent(new Event('touchstart', { bubbles: true })));
    nudge();
    expect(scrollBy).not.toHaveBeenCalled();
    act(() => window.dispatchEvent(new Event('touchend')));
    nudge();
    expect(scrollBy).toHaveBeenCalledWith(0, 212);
    expect(area).toBe(document.activeElement);
  });

  it('short box: scrollIntoView nearest and the lift, as today', () => {
    boxHeight = 120;
    open('short', 2);
    expect(intoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
    expect(scrollBy).toHaveBeenCalledWith(0, 212);
  });

  it('listens to no pointer after blur', () => {
    const area = open(LONG, LONG.length);
    const remove = vi.spyOn(window, 'removeEventListener');
    act(() => root?.unmount());
    root = null;
    const gone = remove.mock.calls.map((c) => c[0]);
    expect(gone).toEqual(
      expect.arrayContaining(['pointerup', 'pointercancel', 'touchend', 'touchcancel']),
    );
    expect(area.isConnected).toBe(false);
  });
});
