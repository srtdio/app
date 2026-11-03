// Where the shell scrolls. Two modes, decided from the URL in the shell's own
// render (AppLayout), so the first paint is already right:
//
// - 'page': every in-shell route except Chat. On a phone the document itself
//   scrolls, so mobile browsers (iOS Safari and every iOS browser or in-app
//   browser, Android Chrome, Samsung Internet, Firefox Android) shrink their
//   bars on scroll and the content runs under them. index.css drops the fixed
//   100svh root height under html.scroll-page below md only; laptop keeps the
//   scrolling <main> exactly as before.
// - 'locked': Chat list and thread. The 100svh root with <main> as the
//   scroller, unchanged.
//
// The class is set in an insertion effect (ShellScrollMode in AppLayout): that
// runs in the commit's mutation phase, before any page's layout effect, so a
// page restoring its kept scroll position (src/lib/kept-view.ts) already sees
// the right scroller on the first frame.

import { isLaptopNow } from '@/lib/use-is-laptop';

export type ScrollMode = 'page' | 'locked';

/** The <html> class that turns on document scrolling (phone only, index.css). */
export const PAGE_SCROLL_CLASS = 'scroll-page';

/** Pure: the scroll mode for an in-shell path. Chat (list and thread) stays locked. */
export function scrollModeFor(pathname: string): ScrollMode {
  return pathname === '/chat' || pathname.startsWith('/chat/') ? 'locked' : 'page';
}

/** Put `mode` on the root element (idempotent). */
export function applyScrollMode(mode: ScrollMode, root?: Element | null): void {
  const el = root ?? (typeof document === 'undefined' ? null : document.documentElement);
  el?.classList.toggle(PAGE_SCROLL_CLASS, mode === 'page');
}

/** The root is in page mode (class only; laptop width is not checked). */
export function pageModeClassOn(): boolean {
  if (typeof document === 'undefined') return false;
  return document.documentElement?.classList?.contains(PAGE_SCROLL_CLASS) === true;
}

/** The document is the shell's scroller right now: page mode on a phone width. */
export function pageScrollActive(): boolean {
  return pageModeClassOn() && !isLaptopNow();
}

/** The document's own scroller (html in standards mode). */
export function documentScroller(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const el = document.scrollingElement ?? document.documentElement;
  return el instanceof HTMLElement ? el : null;
}

/**
 * The shell's page scroller: the document in page mode on a phone, else
 * AppLayout's <main> (locked mode, and laptop in either mode).
 */
export function shellScroller(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  if (pageScrollActive()) return documentScroller();
  return document.querySelector('main');
}

/**
 * A 56px (h-14) bar that, in page mode on a phone, also covers the status bar
 * strip: the safe-area inset becomes top padding on the same surface, so the
 * visible bar keeps its 55px content row. --shell-safe-top is set only under
 * html.scroll-page below md (index.css); unset it is 0px, the old h-14.
 */
export const SAFE_TOP_BAR_CLASS =
  'h-[calc(3.5rem+var(--shell-safe-top,0px))] pt-[var(--shell-safe-top,0px)]';

/**
 * A sticky header's top: 0 inside the locked <main> (and on laptop); below the
 * sticky Topbar (56px + the safe-area inset) when the document scrolls.
 */
export const SHELL_STICKY_TOP_CLASS = 'top-[var(--shell-sticky-top,0px)]';
