import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { focusRestoreTop, initViewportLock } from '@/lib/viewport-lock';
import {
  LAPTOP,
  matchMediaFor,
  MOUSE_AT_TABLET_WIDTH,
  PHONE,
  TABLET_LANDSCAPE,
  TABLET_PORTRAIT,
  type MediaDevice,
} from '@/lib/__tests__/media-device';

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

// Page mode (html.scroll-page, src/lib/scroll-mode.ts): the document is the
// scroller, so the window's position is the person's own and is never reset
// to 0; only the keyboard gap is mended, back to where the field took focus.
describe('initViewportLock in page mode', () => {
  type FakeWindow = EventTarget & {
    scrollY: number;
    scrollTo: ReturnType<typeof vi.fn>;
    visualViewport: EventTarget | null;
  };

  function stubWindow(scrollY: number): FakeWindow {
    const win = new EventTarget() as FakeWindow;
    win.scrollY = scrollY;
    win.scrollTo = vi.fn();
    win.visualViewport = new EventTarget();
    vi.stubGlobal('window', win);
    return win;
  }

  const root = { clientHeight: 800 };
  function stubPageDocument(activeElement: unknown): void {
    vi.stubGlobal('document', {
      activeElement,
      documentElement: {
        classList: { contains: (name: string) => name === 'scroll-page' },
        get clientHeight() {
          return root.clientHeight;
        },
      },
    });
  }

  function focusEvent(win: FakeWindow, type: string, target: unknown, related: unknown): void {
    const event = new Event(type);
    Object.defineProperty(event, 'target', { value: target });
    Object.defineProperty(event, 'relatedTarget', { value: related });
    win.dispatchEvent(event);
  }

  const body = { tagName: 'BODY' };
  const input = { tagName: 'INPUT', type: 'text' };

  beforeEach(() => {
    root.clientHeight = 800;
  });

  it('never scrolls to 0,0 on a visualViewport resize (the bars shrinking)', () => {
    const win = stubWindow(1_200);
    stubPageDocument(body);
    initViewportLock();
    win.visualViewport?.dispatchEvent(new Event('resize'));
    win.visualViewport?.dispatchEvent(new Event('resize'));
    expect(win.scrollTo).not.toHaveBeenCalled();
  });

  it('never resets on focusout when the root height did not shrink', () => {
    const win = stubWindow(1_200);
    stubPageDocument(body);
    initViewportLock();
    focusEvent(win, 'focusin', input, null);
    win.scrollY = 1_500;
    focusEvent(win, 'focusout', input, null);
    expect(win.scrollTo).not.toHaveBeenCalled();
  });

  it('puts back the focusin position when the root shrank and did not recover', () => {
    const win = stubWindow(1_200);
    stubPageDocument(body);
    initViewportLock();
    focusEvent(win, 'focusin', input, null);
    root.clientHeight = 500;
    win.scrollY = 1_536;
    focusEvent(win, 'focusout', input, body);
    expect(win.scrollTo).toHaveBeenCalledTimes(1);
    expect(win.scrollTo).toHaveBeenCalledWith(0, 1_200);
  });

  it('keeps the first position while focus moves between text fields', () => {
    const win = stubWindow(1_200);
    stubPageDocument(body);
    initViewportLock();
    focusEvent(win, 'focusin', input, null);
    win.scrollY = 1_400;
    focusEvent(win, 'focusout', input, { tagName: 'TEXTAREA' });
    focusEvent(win, 'focusin', { tagName: 'TEXTAREA' }, input);
    expect(win.scrollTo).not.toHaveBeenCalled();
    root.clientHeight = 500;
    focusEvent(win, 'focusout', { tagName: 'TEXTAREA' }, null);
    expect(win.scrollTo).toHaveBeenCalledWith(0, 1_200);
  });
});

describe('focusRestoreTop', () => {
  it('is null without a snapshot, when the root recovered, or when already there', () => {
    expect(focusRestoreTop(null, { top: 10, rootHeight: 100 })).toBeNull();
    expect(focusRestoreTop({ top: 10, rootHeight: 800 }, { top: 300, rootHeight: 800 })).toBeNull();
    expect(focusRestoreTop({ top: 10, rootHeight: 800 }, { top: 10, rootHeight: 500 })).toBeNull();
  });

  it('is the focusin position when the root shrank', () => {
    expect(focusRestoreTop({ top: 10, rootHeight: 800 }, { top: 336, rootHeight: 500 })).toBe(10);
  });
});

// Regression: html.scroll-page is set on every non-chat route at every width,
// but only a phone or a touch tablet scrolls the document. A laptop, or an
// iPad with a trackpad, is still the locked 100svh shell and must keep the
// WebKit 297779 reset to 0,0.
describe('initViewportLock: page class by width', () => {
  type FakeWindow = EventTarget & {
    scrollY: number;
    scrollTo: ReturnType<typeof vi.fn>;
    visualViewport: EventTarget | null;
    matchMedia: (q: string) => { matches: boolean };
  };

  const root = { clientHeight: 800 };

  function stub(laptop: boolean | MediaDevice, scrollY: number): FakeWindow {
    const device = typeof laptop === 'boolean' ? (laptop ? LAPTOP : PHONE) : laptop;
    const win = new EventTarget() as FakeWindow;
    win.scrollY = scrollY;
    win.scrollTo = vi.fn();
    win.visualViewport = new EventTarget();
    win.matchMedia = matchMediaFor(() => device);
    vi.stubGlobal('window', win);
    vi.stubGlobal('document', {
      activeElement: { tagName: 'BODY' },
      documentElement: {
        classList: { contains: (name: string) => name === 'scroll-page' },
        get clientHeight() {
          return root.clientHeight;
        },
      },
    });
    return win;
  }

  function fire(win: FakeWindow, type: string, target: unknown, related: unknown): void {
    const event = new Event(type);
    Object.defineProperty(event, 'target', { value: target });
    Object.defineProperty(event, 'relatedTarget', { value: related });
    win.dispatchEvent(event);
  }

  const body = { tagName: 'BODY' };
  const input = { tagName: 'INPUT', type: 'text' };

  beforeEach(() => {
    root.clientHeight = 800;
  });

  it('md and up: focusout to a non-text target resets a scrolled window to 0,0', () => {
    const win = stub(true, 320);
    initViewportLock();
    fire(win, 'focusin', input, null);
    fire(win, 'focusout', input, body);
    expect(win.scrollTo).toHaveBeenCalledTimes(1);
    expect(win.scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it('md and up: a visualViewport resize resets a scrolled window to 0,0', () => {
    const win = stub(true, 320);
    initViewportLock();
    win.visualViewport?.dispatchEvent(new Event('resize'));
    expect(win.scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it('phone: never resets; focusout without a root shrink leaves the window', () => {
    const win = stub(false, 1_200);
    initViewportLock();
    win.visualViewport?.dispatchEvent(new Event('resize'));
    fire(win, 'focusin', input, null);
    fire(win, 'focusout', input, body);
    expect(win.scrollTo).not.toHaveBeenCalled();
  });

  // Touch tablets (iPad portrait and landscape, Android tablets) scroll the
  // document in page mode as a phone does: the iPad keyboard (docked, split
  // or floating) never resets the reading position to the top.
  it.each([TABLET_PORTRAIT, TABLET_LANDSCAPE])(
    'touch tablet: never resets to the top (%o)',
    (tablet) => {
      const win = stub(tablet, 1_200);
      initViewportLock();
      win.visualViewport?.dispatchEvent(new Event('resize'));
      fire(win, 'focusin', input, null);
      fire(win, 'focusout', input, body);
      expect(win.scrollTo).not.toHaveBeenCalled();
    },
  );

  it('touch tablet: a keyboard that shrank the root is mended back to the focusin position', () => {
    const win = stub(TABLET_PORTRAIT, 1_200);
    initViewportLock();
    fire(win, 'focusin', input, null);
    root.clientHeight = 500;
    win.scrollY = 1_536;
    fire(win, 'focusout', input, body);
    expect(win.scrollTo).toHaveBeenCalledTimes(1);
    expect(win.scrollTo).toHaveBeenCalledWith(0, 1_200);
  });

  it('iPad with a trackpad (mouse at tablet width): the locked reset as before', () => {
    const win = stub(MOUSE_AT_TABLET_WIDTH, 320);
    initViewportLock();
    win.visualViewport?.dispatchEvent(new Event('resize'));
    expect(win.scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it('phone: restores the focusin position only when the root shrank', () => {
    const win = stub(false, 1_200);
    initViewportLock();
    fire(win, 'focusin', input, null);
    root.clientHeight = 500;
    win.scrollY = 1_536;
    fire(win, 'focusout', input, body);
    expect(win.scrollTo).toHaveBeenCalledTimes(1);
    expect(win.scrollTo).toHaveBeenCalledWith(0, 1_200);
  });
});
