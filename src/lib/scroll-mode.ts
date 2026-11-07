// Where the shell scrolls. Two modes, decided from the URL in the shell's own
// render (AppLayout), so the first paint is already right:
//
// - 'page': every in-shell route except a chat thread (and Chat on a touch
//   tablet, below). On a phone or a touch tablet
//   (PAGE_SCROLL_QUERY) the document itself scrolls, so mobile browsers (iOS
//   and iPadOS Safari and every iOS browser or in-app browser, Android Chrome,
//   Samsung Internet, Firefox Android) shrink their bars on scroll and the
//   content runs under them. index.css drops the fixed 100svh root height
//   under html.scroll-page inside @media PAGE_SCROLL_QUERY only; a laptop or
//   desktop with a mouse or trackpad (an iPad with one attached included)
//   keeps the scrolling <main> exactly as before.
//   The chat list (/chat with no ?channel=) is page mode on a phone: the list
//   grows and the document scrolls it, its header pinned below the Topbar.
// - 'locked': a chat thread (/chat?channel=...), and all of Chat on a touch
//   tablet, where the list and the thread share the screen (two panes). The
//   100svh root with <main> as the scroller, unchanged. The thread owns its
//   own scroller (stick-to-bottom, windowing, load older, jumps) and the
//   keyboard rule (e2e chat-keyboard-gap: never pinned to the visual viewport)
//   is proven against it, so it stays exactly as it was.
//
// The class is set in an insertion effect (ShellScrollMode in AppLayout): that
// runs in the commit's mutation phase, before any page's layout effect, so a
// page restoring its kept scroll position (src/lib/kept-view.ts) already sees
// the right scroller on the first frame.

import { useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';

export type ScrollMode = 'page' | 'locked';

// The device rule, one source of truth for CSS and JS. index.css carries these
// exact strings in its @media lines (guarded by scroll-mode-css.test.ts), so
// the stylesheet and pageScrollActive() can never disagree. Media queries, not
// a JS-set root class: the CSS is right on the first frame before any script
// runs, and nothing on the paint path waits for a listener. No UA sniffing.

/** A phone: below Tailwind md (unchanged from the width-only rule). */
export const PHONE_QUERY = '(max-width: 767.98px)';

/**
 * A touch tablet: md width and up whose primary pointer is a finger (iPad
 * portrait and landscape, Android tablets). An iPad with a trackpad or mouse
 * attached reports (hover: hover) / (pointer: fine) and is a laptop here.
 */
export const TOUCH_TABLET_QUERY = '(min-width: 768px) and (hover: none) and (pointer: coarse)';

/** Where page mode scrolls the document: a phone OR a touch tablet. */
export const PAGE_SCROLL_QUERY = `${PHONE_QUERY}, ${TOUCH_TABLET_QUERY}`;

// Without matchMedia (a bare test environment) the device reads as a phone,
// as useIsLaptop does: page mode active, not a touch tablet.
function mediaMatches(media: string, fallback: boolean): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(media).matches
    : fallback;
}

/** The <html> class that turns on document scrolling (phone and touch tablet, index.css). */
export const PAGE_SCROLL_CLASS = 'scroll-page';

/**
 * Pure: the scroll mode for an in-shell path. `search` is the URL query (with
 * or without the leading '?'), `touchTablet` the device (useTouchTablet).
 * - Chat list (/chat, no ?channel=): 'page' (the document scrolls it on a
 *   phone; a laptop keeps the locked shell, the CSS is phone/tablet only), but
 *   'locked' on a touch tablet, where the list sits beside the thread pane.
 * - Chat thread (/chat?channel=..., and any /chat/...): 'locked'.
 * - Every other route: 'page'.
 */
export function scrollModeFor(
  pathname: string,
  search: string | URLSearchParams = '',
  touchTablet = false,
): ScrollMode {
  if (pathname.startsWith('/chat/')) return 'locked';
  if (pathname !== '/chat') return 'page';
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const channel = params.get('channel');
  if (channel !== null && channel !== '') return 'locked';
  return touchTablet ? 'locked' : 'page';
}

/** Put `mode` on the root element (idempotent). */
export function applyScrollMode(mode: ScrollMode, root?: Element | null): void {
  const el = root ?? (typeof document === 'undefined' ? null : document.documentElement);
  el?.classList.toggle(PAGE_SCROLL_CLASS, mode === 'page');
}

/** The root is in page mode (class only; the device is not checked). */
export function pageModeClassOn(): boolean {
  if (typeof document === 'undefined') return false;
  return document.documentElement?.classList?.contains(PAGE_SCROLL_CLASS) === true;
}

/**
 * The document is the shell's scroller right now: page mode on a phone or a
 * touch tablet. One matchMedia read per call, no listener.
 */
export function pageScrollActive(): boolean {
  return pageModeClassOn() && mediaMatches(PAGE_SCROLL_QUERY, true);
}

/** A touch tablet right now (one matchMedia read). */
export function touchTabletNow(): boolean {
  return mediaMatches(TOUCH_TABLET_QUERY, false);
}

/** The document's own scroller (html in standards mode). */
export function documentScroller(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const el = document.scrollingElement ?? document.documentElement;
  return el instanceof HTMLElement ? el : null;
}

/**
 * The shell's page scroller: the document in page mode on a phone or a touch
 * tablet, else AppLayout's <main> (locked mode, and laptop in either mode).
 */
export function shellScroller(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  if (pageScrollActive()) return documentScroller();
  return document.querySelector('main');
}

/**
 * A 56px (h-14) bar that, in page mode on a phone or a touch tablet, also
 * covers the status bar strip: the safe-area inset becomes top padding on the
 * same surface, so the visible bar keeps its 55px content row.
 * --shell-safe-top is set only under html.scroll-page inside @media
 * PAGE_SCROLL_QUERY (index.css; reset to 0 inside <main> on a touch tablet,
 * where the Topbar above already covers the strip); unset it is 0px, the old h-14.
 */
export const SAFE_TOP_BAR_CLASS =
  'h-[calc(3.5rem+var(--shell-safe-top,0px))] pt-[var(--shell-safe-top,0px)]';

/**
 * A sticky header's top: 0 inside the locked <main> (and on laptop); below the
 * sticky Topbar (56px + the safe-area inset) when the document scrolls (phone
 * and touch tablet).
 */
export const SHELL_STICKY_TOP_CLASS = 'top-[var(--shell-sticky-top,0px)]';

/**
 * A pinned exit bar's top (ui/HeaderBar `pinned`): a screen that opens over the
 * app with its own back "<" (Post detail, Brief detail). On a phone the shell
 * drops the Topbar there (AppLayout isDetailRoute), so the bar pins at 0 and
 * covers the status bar strip itself (SAFE_TOP_BAR_CLASS keeps the inset as
 * top padding). md and up: a touch tablet keeps the sticky Topbar, so the bar
 * pins below it (--shell-sticky-top); a laptop scrolls <main>, where the var
 * is unset and the bar pins at 0.
 */
export const PINNED_BAR_TOP_CLASS = 'top-0 md:top-[var(--shell-sticky-top,0px)]';

// ---------------------------------------------------------------------------
// The one device listener. watchScrollDevice() is called once at boot (main.tsx)
// and registers a single 'change' listener on TOUCH_TABLET_QUERY: it flips when
// an iPad gains or loses a trackpad or mouse (pointer coarse <-> fine) and when
// a touch screen crosses 768px (rotation, Split View). The CSS side switches on
// its own (@media); this re-renders the shell chrome (useTouchTablet) in the
// same task and puts the reading position back on whichever element is now the
// scroller, so the switch never jumps. Nothing per frame, nothing per render.

const subscribers = new Set<() => void>();
const watched = new WeakSet<object>();

function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

/** The shell's reading position, whichever element scrolls it right now. */
function shellOffset(): number {
  const doc = documentScroller()?.scrollTop ?? 0;
  const main = typeof document === 'undefined' ? null : document.querySelector('main');
  return Math.max(doc, main?.scrollTop ?? 0);
}

/** Test seam and the listener body: re-evaluate the device, keep the position. */
export function onScrollDeviceChange(): void {
  const top = shellOffset();
  flushSync(() => {
    for (const fn of subscribers) fn();
  });
  const scroller = shellScroller();
  if (scroller !== null && top > 0 && scroller.scrollTop !== top) scroller.scrollTop = top;
}

/** Boot: the one media-query listener (a second call on the same window registers nothing). */
export function watchScrollDevice(win: Window | undefined = globalThis.window): void {
  if (win === undefined || typeof win.matchMedia !== 'function' || watched.has(win)) return;
  watched.add(win);
  win.matchMedia(TOUCH_TABLET_QUERY).addEventListener('change', onScrollDeviceChange);
}

/**
 * A touch tablet (reactive): read in the shell's first render (one matchMedia
 * read, no listener of its own), re-read when the boot listener reports a flip.
 */
export function useTouchTablet(): boolean {
  return useSyncExternalStore(subscribe, touchTabletNow, () => false);
}
