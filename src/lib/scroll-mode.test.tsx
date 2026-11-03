// @vitest-environment jsdom
// Page vs locked scrolling (src/lib/scroll-mode.ts): the mode per route, the
// scroller each mode hands to kept views, and a kept scroll restored and saved
// against the document in page mode and against <main> in locked mode.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyScrollMode,
  PAGE_SCROLL_CLASS,
  pageModeClassOn,
  scrollModeFor,
  shellScroller,
} from '@/lib/scroll-mode';
import { keptViewKey, useKeptScroll } from '@/lib/kept-view';
import { peekKept, resetSessionReads } from '@/lib/session-read';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

function setLaptop(laptop: boolean | null): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value:
      laptop === null
        ? undefined
        : (q: string) => ({
            matches: laptop && q.includes('min-width'),
            media: q,
            addEventListener() {},
            removeEventListener() {},
          }),
  });
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  document.documentElement.classList.remove(PAGE_SCROLL_CLASS);
  setLaptop(null);
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

  it.each(['/chat', '/chat/'])('%s (chat list and thread) stays locked', (path) => {
    expect(scrollModeFor(path)).toBe('locked');
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
