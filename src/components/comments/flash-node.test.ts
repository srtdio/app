import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flashNode } from '@/components/comments/flash-node';

// The repo's vitest runs in the node environment and ships no jsdom dependency,
// so the small DOM surface flashNode touches (document.getElementById, a node's
// scrollIntoView / classList, window.setTimeout) is faked with global stubs and
// fake timers, mirroring how Comments.test.tsx stubs navigator.clipboard.

interface FakeRect {
  top: number;
  height: number;
}

interface FakeScroller {
  parentElement: null;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  overflowY: string;
  scrollTo: ReturnType<typeof vi.fn>;
  getBoundingClientRect: () => FakeRect;
}

interface FakeNode {
  parentElement: FakeScroller | null;
  scrollIntoView: ReturnType<typeof vi.fn>;
  classList: { add: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };
  getBoundingClientRect: () => FakeRect;
}

function makeNode(parent: FakeScroller | null = null): FakeNode {
  return {
    parentElement: parent,
    scrollIntoView: vi.fn(),
    classList: { add: vi.fn(), remove: vi.fn() },
    getBoundingClientRect: () => ({ top: 900, height: 100 }),
  };
}

/** The shell's main: scrolls, 600 tall, at the top of the viewport, scrolled 300. */
function makeScroller(): FakeScroller {
  return {
    parentElement: null,
    scrollTop: 300,
    scrollHeight: 2000,
    clientHeight: 600,
    overflowY: 'auto',
    scrollTo: vi.fn(),
    getBoundingClientRect: () => ({ top: 0, height: 600 }),
  };
}

function stubDom(nodesById: Record<string, FakeNode>): void {
  vi.stubGlobal('document', {
    getElementById: (id: string): FakeNode | null => nodesById[id] ?? null,
    body: {},
    documentElement: {},
  });
  vi.stubGlobal('getComputedStyle', (el: { overflowY?: string }) => ({
    overflowY: el.overflowY ?? 'visible',
    scrollMarginTop: '0px',
    scrollMarginBottom: '0px',
  }));
  // Resolve setTimeout at call time so the active (faked) timer is used.
  vi.stubGlobal('window', {
    setTimeout: (cb: () => void, ms?: number) => globalThis.setTimeout(cb, ms),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('flashNode', () => {
  it('is a no-op (and never throws) when the node is absent', () => {
    stubDom({});
    expect(() => flashNode('missing')).not.toThrow();
  });

  it('adds lit-selected then removes it around the 1200ms timeout', () => {
    const node = makeNode();
    stubDom({ present: node });

    flashNode('present');

    expect(node.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
    expect(node.classList.add).toHaveBeenCalledWith('lit-selected');
    // The selected edge stays until the timeout fires.
    expect(node.classList.remove).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1199);
    expect(node.classList.remove).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(node.classList.remove).toHaveBeenCalledWith('lit-selected');
  });

  it('centres the node in its own scroller and never scrolls the window', () => {
    const scroller = makeScroller();
    const node = makeNode(scroller);
    stubDom({ present: node });

    flashNode('present');

    // Node top 900 (100 tall) in a 600px view scrolled 300: centred at 300 + 900 - 250.
    expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 950, behavior: 'smooth' });
    expect(node.scrollIntoView).not.toHaveBeenCalled();
    expect(node.classList.add).toHaveBeenCalledWith('lit-selected');
  });
});
