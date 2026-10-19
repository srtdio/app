import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initViewportLock } from '@/lib/viewport-lock';

// The repo's vitest runs in the node environment, so `document` is faked with
// a real EventTarget (Node ships global Event / EventTarget); a cancelable
// Event's preventDefault / defaultPrevented behave natively against it.
beforeEach(() => {
  vi.stubGlobal('document', new EventTarget());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('initViewportLock', () => {
  it('no longer prevents the iOS multi-touch gesture events, so pinch zoom works', () => {
    initViewportLock();

    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
      const event = new Event(type, { cancelable: true });
      document.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
  });

  it('registers nothing on the document', () => {
    const add = vi.fn();
    vi.stubGlobal('document', { addEventListener: add });
    initViewportLock();
    expect(add).not.toHaveBeenCalled();
  });
});
