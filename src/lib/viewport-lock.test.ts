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

// Keyboard gap reset (iOS 26 Safari). `window` and `window.visualViewport` are
// faked with real EventTargets; each test stubs a fresh window, so the
// once-per-window registration guard starts clean every time.
describe('initViewportLock keyboard gap reset', () => {
  type FakeWindow = EventTarget & {
    scrollY: number;
    scrollTo: ReturnType<typeof vi.fn>;
    visualViewport: EventTarget | null;
  };

  function stubWindow(opts: { scrollY: number; visualViewport?: boolean }): FakeWindow {
    const win = new EventTarget() as FakeWindow;
    win.scrollY = opts.scrollY;
    // Does not change scrollY, so a duplicate listener would call it again.
    win.scrollTo = vi.fn();
    win.visualViewport = opts.visualViewport === false ? null : new EventTarget();
    vi.stubGlobal('window', win);
    return win;
  }

  function stubActiveElement(el: unknown): void {
    vi.stubGlobal('document', { activeElement: el });
  }

  function focusout(win: FakeWindow, relatedTarget: unknown): void {
    const event = new Event('focusout');
    Object.defineProperty(event, 'relatedTarget', { value: relatedTarget });
    win.dispatchEvent(event);
  }

  const body = { tagName: 'BODY' };
  const input = { tagName: 'INPUT', type: 'text' };

  it('resets the scroll on visualViewport resize when unfocused and scrolled', () => {
    const win = stubWindow({ scrollY: 320 });
    stubActiveElement(body);
    initViewportLock();

    win.visualViewport?.dispatchEvent(new Event('resize'));

    expect(win.scrollTo).toHaveBeenCalledTimes(1);
    expect(win.scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it('resets the scroll on focusout when focus leaves text fields', () => {
    const win = stubWindow({ scrollY: 320 });
    stubActiveElement(body);
    initViewportLock();

    focusout(win, null);

    expect(win.scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it('does not reset while an input is focused', () => {
    const win = stubWindow({ scrollY: 320 });
    stubActiveElement(input);
    initViewportLock();

    win.visualViewport?.dispatchEvent(new Event('resize'));
    focusout(win, input);
    focusout(win, { tagName: 'TEXTAREA' });
    focusout(win, { tagName: 'DIV', isContentEditable: true });

    expect(win.scrollTo).not.toHaveBeenCalled();
  });

  it('does not reset when the window is not scrolled', () => {
    const win = stubWindow({ scrollY: 0 });
    stubActiveElement(body);
    initViewportLock();

    win.visualViewport?.dispatchEvent(new Event('resize'));
    focusout(win, null);

    expect(win.scrollTo).not.toHaveBeenCalled();
  });

  it('registers only once per window even when called twice', () => {
    const win = stubWindow({ scrollY: 320 });
    stubActiveElement(body);
    initViewportLock();
    initViewportLock();

    win.visualViewport?.dispatchEvent(new Event('resize'));

    expect(win.scrollTo).toHaveBeenCalledTimes(1);
  });

  it('still handles focusout when visualViewport is missing', () => {
    const win = stubWindow({ scrollY: 320, visualViewport: false });
    stubActiveElement(body);
    expect(() => initViewportLock()).not.toThrow();

    focusout(win, null);

    expect(win.scrollTo).toHaveBeenCalledWith(0, 0);
  });
});
