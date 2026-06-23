import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initViewportLock } from '@/lib/viewport-lock';

// The repo's vitest runs in the node environment and ships no jsdom dependency,
// so `document` is faked with a real EventTarget (Node ships global Event /
// EventTarget). addEventListener/dispatchEvent and a cancelable Event's
// preventDefault / defaultPrevented all behave natively against it, mirroring
// how flash-node.test.ts stubs the small DOM surface it touches.
beforeEach(() => {
  vi.stubGlobal('document', new EventTarget());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('initViewportLock', () => {
  it('prevents the iOS multi-touch gesture events', () => {
    initViewportLock();

    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
      const event = new Event(type, { cancelable: true });
      document.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
  });

  it('leaves unrelated (non-gesture) events alone', () => {
    initViewportLock();

    const event = new Event('touchstart', { cancelable: true });
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
