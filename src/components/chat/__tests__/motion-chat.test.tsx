// @vitest-environment jsdom
// The chat's motion (docs/motion.md): the thread view's push skips its back
// move when the browser already animated it (iPhone swipe,
// hasUAVisualTransition); a new message plays itemIn only for keys that arrive
// after first paint, at the tail; the thread's loading boxes render only when
// nothing is held for the chat.

import { act, useRef, useLayoutEffect, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { ThreadViewFrame } from '@/components/chat/ThreadView';
import { threadSkeleton } from '@/components/chat/MessageThread';
import { chatThreadLoading } from '@/components/chat/ChatConnected';
import { freshTailIds } from '@/lib/chat/fresh-tail';
import { itemIn, resetPlayerForTests, useFreshKeys, watchUAVisualTransition } from '@/lib/motion';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type AnimateFn = HTMLElement['animate'];
const original = (HTMLElement.prototype as { animate?: AnimateFn }).animate;
let animate: ReturnType<typeof vi.fn>;
/** The element each animate() call ran on, in call order. */
let targets: Element[] = [];
let root: Root | null = null;

beforeEach(() => {
  targets = [];
  animate = vi.fn(function (this: Element) {
    targets.push(this);
    return { addEventListener: vi.fn(), finish: vi.fn(), cancel: vi.fn() };
  });
  (HTMLElement.prototype as { animate?: unknown }).animate = animate;
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  resetPlayerForTests();
  if (original === undefined) delete (HTMLElement.prototype as { animate?: unknown }).animate;
  else (HTMLElement.prototype as { animate?: unknown }).animate = original;
});

function mount(node: ReactElement): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(node));
  return host;
}

function frame(onClosed: () => void): ReactElement {
  return (
    <ThreadViewFrame title="Launch teaser" selecting={false} onClosed={onClosed}>
      <div data-thread-body="" />
    </ThreadViewFrame>
  );
}

function closeButton(host: HTMLElement): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>('[data-thread-view-close]');
  if (button === null) throw new Error('no close button');
  return button;
}

describe('thread view push (phone)', () => {
  it('pushes in on its first frame and pushes back on Close, then unmounts', () => {
    const onClosed = vi.fn();
    const host = mount(frame(onClosed));
    // pushIn: one move on the view, from the right (X only, never opacity).
    expect(animate).toHaveBeenCalledTimes(1);
    const [inFrames] = animate.mock.calls[0] as [Keyframe[]];
    expect(inFrames[0]).toEqual({ transform: 'translateX(100%)' });
    expect(JSON.stringify(inFrames)).not.toContain('opacity');
    act(() => closeButton(host).click());
    // pushBack runs; the view goes once it ends.
    expect(animate).toHaveBeenCalledTimes(2);
    const [backFrames] = animate.mock.calls[1] as [Keyframe[]];
    expect(backFrames[1]).toEqual({ transform: 'translateX(100%)' });
    expect(onClosed).not.toHaveBeenCalled();
  });

  it('skips the back move when popstate had hasUAVisualTransition (iPhone swipe)', () => {
    watchUAVisualTransition();
    const onClosed = vi.fn();
    const host = mount(frame(onClosed));
    expect(animate).toHaveBeenCalledTimes(1);
    animate.mockClear();
    const pop = new PopStateEvent('popstate');
    Object.defineProperty(pop, 'hasUAVisualTransition', { value: true });
    // The history step's back clicks the view's Close inside the popstate.
    window.addEventListener('popstate', () => closeButton(host).click(), { once: true });
    act(() => {
      window.dispatchEvent(pop);
    });
    expect(animate).not.toHaveBeenCalled();
    expect(onClosed).toHaveBeenCalledTimes(1);
  });
});

describe('new message itemIn', () => {
  it('only keys that arrive after first paint, at the tail', () => {
    expect(freshTailIds(null, ['a', 'b'], new Set())).toEqual([]);
    // Sent or received after first paint: the new tail row.
    expect(freshTailIds(['a', 'b'], ['a', 'b', 'c'], new Set(['c']))).toEqual(['c']);
    // An older page above never moves.
    expect(freshTailIds(['b', 'c'], ['a', 'b', 'c'], new Set(['a']))).toEqual([]);
    // Another chat (its newest row is gone) never moves.
    expect(freshTailIds(['x'], ['a', 'b'], new Set(['a', 'b']))).toEqual([]);
    // A first load into an empty list never moves.
    expect(freshTailIds([], ['a', 'b'], new Set(['a', 'b']))).toEqual([]);
  });

  /** The thread's wiring (MessageThread): useFreshKeys + freshTailIds + itemIn. */
  function List(props: { ids: string[] }): ReactElement {
    const ref = useRef<HTMLUListElement>(null);
    const fresh = useFreshKeys(props.ids);
    const prev = useRef<readonly string[] | null>(null);
    useLayoutEffect(() => {
      const before = prev.current;
      prev.current = props.ids;
      for (const id of freshTailIds(before, props.ids, fresh)) {
        itemIn(ref.current?.querySelector(`[data-msg-id="${id}"]`) ?? null);
      }
    }, [props.ids, fresh]);
    return (
      <ul ref={ref}>
        {props.ids.map((id) => (
          <li key={id} data-msg-id={id} />
        ))}
      </ul>
    );
  }

  it('a kept or cached first paint never animates; a new tail row rises on Y', () => {
    const host = mount(<List ids={['a', 'b']} />);
    expect(animate).not.toHaveBeenCalled();
    act(() => root?.render(<List ids={['a', 'b', 'c']} />));
    expect(animate).toHaveBeenCalledTimes(1);
    expect(targets[0]).toBe(host.querySelector('[data-msg-id="c"]'));
    const [frames] = animate.mock.calls[0] as [Keyframe[]];
    expect(frames[0]).toEqual({ transform: 'translateY(8px)' });
    // An older page prepended: nothing moves.
    act(() => root?.render(<List ids={['z', 'a', 'b', 'c']} />));
    expect(animate).toHaveBeenCalledTimes(1);
  });
});

describe('thread loading boxes', () => {
  const READY = {
    threadCurrent: true,
    notesFailed: false,
    pageLoading: false,
    namesReady: true,
    notesOpen: false,
    notesStatusReady: false,
    notesReady: false,
    savedReady: true,
  };

  it('render only while the chat holds nothing (kept rows paint at once)', () => {
    expect(chatThreadLoading(READY)).toBe(false);
    expect(chatThreadLoading({ ...READY, pageLoading: true })).toBe(true);
  });

  it('are bubble-shaped Bone boxes on alternating sides, never a pulse', () => {
    const html = renderToStaticMarkup(threadSkeleton());
    const sides = [...html.matchAll(/data-skeleton-bubble="(own|other)"/g)].map((m) => m[1]);
    expect(sides).toEqual(['other', 'own', 'other', 'own', 'other']);
    expect(html.match(/data-bone=""/g)).toHaveLength(5);
    expect(html).toContain('rounded-xl');
    expect(html).not.toMatch(/animate-pulse|opacity|transition/);
  });
});
