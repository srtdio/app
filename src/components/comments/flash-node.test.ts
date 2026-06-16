import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flashNode } from '@/components/comments/flash-node';

// The repo's vitest runs in the node environment and ships no jsdom dependency,
// so the small DOM surface flashNode touches (document.getElementById, a node's
// scrollIntoView / classList, window.setTimeout) is faked with global stubs and
// fake timers, mirroring how Comments.test.tsx stubs navigator.clipboard.

interface FakeNode {
  scrollIntoView: ReturnType<typeof vi.fn>;
  classList: { add: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };
}

function makeNode(): FakeNode {
  return {
    scrollIntoView: vi.fn(),
    classList: { add: vi.fn(), remove: vi.fn() },
  };
}

function stubDom(nodesById: Record<string, FakeNode>): void {
  vi.stubGlobal('document', {
    getElementById: (id: string): FakeNode | null => nodesById[id] ?? null,
  });
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

  it('adds the ring classes then removes them around the 1200ms timeout', () => {
    const node = makeNode();
    stubDom({ present: node });

    flashNode('present');

    expect(node.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
    expect(node.classList.add).toHaveBeenCalledWith('ring-2', 'ring-annotation-line');
    // The ring stays until the timeout fires.
    expect(node.classList.remove).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1199);
    expect(node.classList.remove).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(node.classList.remove).toHaveBeenCalledWith('ring-2', 'ring-annotation-line');
  });
});
