// @vitest-environment jsdom
// Page vs locked scrolling (src/lib/scroll-mode.ts): the mode per route, the
// scroller each mode hands to kept views, and a kept scroll restored and saved
// against the document in page mode and against <main> in locked mode.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyScrollMode,
  onScrollDeviceChange,
  PAGE_SCROLL_CLASS,
  PAGE_SCROLL_QUERY,
  pageModeClassOn,
  pageScrollActive,
  scrollModeFor,
  shellScroller,
  TOUCH_TABLET_QUERY,
  touchTabletNow,
  useTouchTablet,
  watchScrollDevice,
} from '@/lib/scroll-mode';
import { keptViewKey, useKeptScroll } from '@/lib/kept-view';
import { peekKept, resetSessionReads } from '@/lib/session-read';
import {
  LAPTOP,
  matchMediaFor,
  MOUSE_AT_TABLET_WIDTH,
  PHONE,
  TABLET_LANDSCAPE,
  TABLET_PORTRAIT,
  type MediaDevice,
} from '@/lib/__tests__/media-device';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let device: MediaDevice = PHONE;
const listeners: Array<{ media: string; fn: () => void }> = [];

function setDevice(next: MediaDevice | null): void {
  if (next !== null) device = next;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: next === null ? undefined : matchMediaFor(() => device, listeners),
  });
}

function setLaptop(laptop: boolean | null): void {
  setDevice(laptop === null ? null : laptop ? LAPTOP : PHONE);
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  document.documentElement.classList.remove(PAGE_SCROLL_CLASS);
  setLaptop(null);
  listeners.length = 0;
  resetSessionReads();
});

describe('scrollModeFor', () => {
  it.each([
    '/pipeline',
    '/posts/abc',
    '/p/gbl-1',
    '/briefs',
    '/briefs/abc',
    '/b/ref',
    '/notifications',
    '/plans/x',
    '/plan',
    '/plan/x',
    '/assets',
    '/settings',
    '/help',
    '/deleted',
    '/activity',
  ])('%s scrolls the page', (path) => {
    expect(scrollModeFor(path)).toBe('page');
  });

  it('the chat list (/chat, no channel) scrolls the page on a phone', () => {
    expect(scrollModeFor('/chat')).toBe('page');
    expect(scrollModeFor('/chat', '')).toBe('page');
    expect(scrollModeFor('/chat', '?channel=')).toBe('page');
    expect(scrollModeFor('/chat', new URLSearchParams('q=x'))).toBe('page');
    expect(scrollModeFor('/chat', '', false)).toBe('page');
  });

  it.each(['?channel=dm-1', 'channel=dm-1&message=m-9', '?message=m&channel=g'])(
    'a chat thread (/chat%s) stays locked on every device',
    (search) => {
      expect(scrollModeFor('/chat', search)).toBe('locked');
      expect(scrollModeFor('/chat', new URLSearchParams(search))).toBe('locked');
      expect(scrollModeFor('/chat', search, true)).toBe('locked');
    },
  );

  it('the chat list on a touch tablet (two panes beside the thread) stays locked', () => {
    expect(scrollModeFor('/chat', '', true)).toBe('locked');
  });

  it('a /chat/ sub-path stays locked', () => {
    expect(scrollModeFor('/chat/')).toBe('locked');
    expect(scrollModeFor('/chat/x', '', false)).toBe('locked');
  });

  it('the device and query never change any other route', () => {
    expect(scrollModeFor('/pipeline', '?channel=x', true)).toBe('page');
    expect(scrollModeFor('/activity', '', true)).toBe('page');
  });

  it('a path that only starts with "chat" is not chat', () => {
    expect(scrollModeFor('/chatter')).toBe('page');
  });
});

describe('applyScrollMode', () => {
  it('toggles the one html class', () => {
    applyScrollMode('page');
    expect(document.documentElement.classList.contains(PAGE_SCROLL_CLASS)).toBe(true);
    expect(pageModeClassOn()).toBe(true);
    applyScrollMode('page');
    expect(document.documentElement.className.split(' ').filter(Boolean)).toEqual([
      PAGE_SCROLL_CLASS,
    ]);
    applyScrollMode('locked');
    expect(pageModeClassOn()).toBe(false);
  });
});

describe('shellScroller', () => {
  function addMain(): HTMLElement {
    const main = document.createElement('main');
    document.body.appendChild(main);
    return main;
  }

  it('is <main> in locked mode', () => {
    const main = addMain();
    setLaptop(false);
    expect(shellScroller()).toBe(main);
  });

  it('is the document in page mode on a phone', () => {
    addMain();
    setLaptop(false);
    applyScrollMode('page');
    expect(shellScroller()).toBe(document.scrollingElement ?? document.documentElement);
  });

  it('stays <main> in page mode on laptop (laptop unchanged)', () => {
    const main = addMain();
    setLaptop(true);
    applyScrollMode('page');
    expect(shellScroller()).toBe(main);
  });
});

describe('device rule (one query string for CSS and JS)', () => {
  it('page scroll is phone OR touch tablet', () => {
    expect(TOUCH_TABLET_QUERY).toBe('(min-width: 768px) and (hover: none) and (pointer: coarse)');
    expect(PAGE_SCROLL_QUERY).toBe(`(max-width: 767.98px), ${TOUCH_TABLET_QUERY}`);
  });

  it.each([
    ['phone', PHONE, true, false],
    ['touch tablet portrait', TABLET_PORTRAIT, true, true],
    ['touch tablet landscape', TABLET_LANDSCAPE, true, true],
    ['mouse or trackpad at the same width', MOUSE_AT_TABLET_WIDTH, false, false],
    ['laptop', LAPTOP, false, false],
  ] as const)('%s: page route scrolls the document = %s', (_name, d, page, tablet) => {
    const main = document.createElement('main');
    document.body.appendChild(main);
    setDevice(d);
    applyScrollMode(scrollModeFor('/pipeline'));
    expect(pageScrollActive()).toBe(page);
    expect(touchTabletNow()).toBe(tablet);
    const doc = document.scrollingElement ?? document.documentElement;
    expect(shellScroller()).toBe(page ? doc : main);
  });

  it.each([PHONE, TABLET_PORTRAIT, TABLET_LANDSCAPE, MOUSE_AT_TABLET_WIDTH, LAPTOP])(
    'a chat thread stays locked on every device (%o)',
    (d) => {
      const main = document.createElement('main');
      document.body.appendChild(main);
      setDevice(d);
      applyScrollMode(scrollModeFor('/chat', '?channel=dm-1', touchTabletNow()));
      expect(pageScrollActive()).toBe(false);
      expect(shellScroller()).toBe(main);
    },
  );

  it.each([
    ['phone', PHONE, true],
    ['touch tablet portrait', TABLET_PORTRAIT, false],
    ['touch tablet landscape', TABLET_LANDSCAPE, false],
    ['mouse or trackpad at the same width', MOUSE_AT_TABLET_WIDTH, false],
    ['laptop', LAPTOP, false],
  ] as const)('%s: the chat list scrolls the document = %s', (_name, d, page) => {
    const main = document.createElement('main');
    document.body.appendChild(main);
    setDevice(d);
    applyScrollMode(scrollModeFor('/chat', '', touchTabletNow()));
    expect(pageScrollActive()).toBe(page);
    const doc = document.scrollingElement ?? document.documentElement;
    expect(shellScroller()).toBe(page ? doc : main);
  });

  it('without matchMedia reads as a phone (as useIsLaptop does)', () => {
    setDevice(null);
    applyScrollMode('page');
    expect(pageScrollActive()).toBe(true);
    expect(touchTabletNow()).toBe(false);
  });
});

describe('watchScrollDevice: the one boot listener', () => {
  function settable(el: HTMLElement): void {
    let top = 0;
    Object.defineProperty(el, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = v;
      },
    });
  }

  it('registers one change listener on the touch tablet query, once per window', () => {
    setDevice(TABLET_PORTRAIT);
    watchScrollDevice(window);
    watchScrollDevice(window);
    expect(listeners).toHaveLength(1);
    expect(listeners[0]?.media).toBe(TOUCH_TABLET_QUERY);
  });

  it('a trackpad attached on a scrolled iPad switches mode and keeps the position', () => {
    const main = document.createElement('main');
    document.body.appendChild(main);
    settable(main);
    const doc = (document.scrollingElement ?? document.documentElement) as HTMLElement;
    settable(doc);
    setDevice(TABLET_PORTRAIT);
    applyScrollMode('page');

    const seen: boolean[] = [];
    function Probe() {
      seen.push(useTouchTablet());
      return null;
    }
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<Probe />));
    expect(seen.at(-1)).toBe(true);
    expect(shellScroller()).toBe(doc);

    doc.scrollTop = 900;
    // Trackpad attached: pointer flips to fine, the CSS goes back to the locked shell.
    device = MOUSE_AT_TABLET_WIDTH;
    act(() => onScrollDeviceChange());
    expect(seen.at(-1)).toBe(false);
    expect(shellScroller()).toBe(main);
    // The reading position moved to the new scroller: no reset to the top.
    expect(main.scrollTop).toBe(900);

    // Detached again: back to the document at the same place.
    doc.scrollTop = 0;
    device = TABLET_PORTRAIT;
    act(() => onScrollDeviceChange());
    expect(seen.at(-1)).toBe(true);
    expect(doc.scrollTop).toBe(900);
  });

  it('at the top nothing is written', () => {
    const main = document.createElement('main');
    document.body.appendChild(main);
    // A fresh document position (the test above left its own at 900).
    settable((document.scrollingElement ?? document.documentElement) as HTMLElement);
    const write = vi.fn();
    Object.defineProperty(main, 'scrollTop', { configurable: true, get: () => 0, set: write });
    setDevice(TABLET_PORTRAIT);
    applyScrollMode('page');
    device = MOUSE_AT_TABLET_WIDTH;
    onScrollDeviceChange();
    expect(write).not.toHaveBeenCalled();
  });
});

describe('useKeptScroll against the active scroller', () => {
  const KEY = keptViewKey('u', 'w', 'pipeline:scroll');

  function Screen() {
    useKeptScroll(KEY, true);
    return null;
  }

  function mount(): void {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<Screen />));
  }

  function settable(el: HTMLElement): void {
    let top = 0;
    Object.defineProperty(el, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = v;
      },
    });
  }

  it('page mode: saves from window scroll events and restores on the document', () => {
    const main = document.createElement('main');
    document.body.appendChild(main);
    settable(main);
    const doc = (document.scrollingElement ?? document.documentElement) as HTMLElement;
    settable(doc);
    setLaptop(false);
    applyScrollMode('page');

    mount();
    doc.scrollTop = 640;
    window.dispatchEvent(new Event('scroll'));
    expect(peekKept<number>(KEY)).toBe(640);
    // A scroll on main (not the scroller here) is not the page's position.
    main.scrollTop = 5;
    main.dispatchEvent(new Event('scroll'));
    expect(peekKept<number>(KEY)).toBe(640);

    act(() => root!.unmount());
    doc.scrollTop = 0;
    mount();
    expect(doc.scrollTop).toBe(640);
    expect(main.scrollTop).toBe(5);
  });

  it('locked mode: saves and restores on <main>', () => {
    const main = document.createElement('main');
    document.body.appendChild(main);
    settable(main);
    setLaptop(false);

    mount();
    main.scrollTop = 300;
    main.dispatchEvent(new Event('scroll'));
    expect(peekKept<number>(KEY)).toBe(300);
    act(() => root!.unmount());
    main.scrollTop = 0;
    mount();
    expect(main.scrollTop).toBe(300);
  });
});

// Highlights (focus-target, flash-node, SearchHighlight) centre a row in its
// scrollParent, or by the window when there is none. Page-mode <main> clips
// sideways only (overflow-x: clip leaves overflow-y visible), so it is no
// scroll parent and the window, now the real scroller, centres the row,
// counting the current scroll offset.
describe('highlights with the document as the scroller', () => {
  it('page-mode main is not a scroll parent; the window offset is counted', async () => {
    const { centredTop, scrollParent } = await import('@/lib/focus-target');
    const main = document.createElement('main');
    main.style.overflowX = 'clip';
    const row = document.createElement('div');
    main.appendChild(row);
    document.body.appendChild(main);
    expect(scrollParent(row)).toBeNull();

    // Scrolled 1200px, a 600px window, a 40px row whose top is 900px down the
    // window: centred means the row's middle at 300px of the window.
    const top = centredTop({
      scrollTop: 1_200,
      viewTop: 0,
      viewHeight: 600,
      elTop: 900,
      elHeight: 40,
      marginTop: 0,
      marginBottom: 0,
    });
    expect(top).toBe(1_200 + 900 - (600 - 40) / 2);
  });

  it('locked main (overflow-y auto with overflow) stays the scroll parent', async () => {
    const { scrollParent } = await import('@/lib/focus-target');
    const main = document.createElement('main');
    main.style.overflowY = 'auto';
    Object.defineProperty(main, 'scrollHeight', { value: 2_000 });
    Object.defineProperty(main, 'clientHeight', { value: 600 });
    const row = document.createElement('div');
    main.appendChild(row);
    document.body.appendChild(main);
    expect(scrollParent(row)).toBe(main);
  });
});
