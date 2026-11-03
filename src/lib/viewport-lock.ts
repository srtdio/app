// Pinch zoom is allowed. This module used to cancel Safari's multi-touch
// gesture events ('gesturestart'/'gesturechange'/'gestureend') to lock the
// page at 1x; that also took away the accessibility zoom people rely on, so
// it no longer does. iOS zoom-on-focus is prevented at the source instead:
// every text field is 16px below md (Input, Textarea, the Select trigger), and
// the viewport meta no longer sets maximum-scale or user-scalable.
//
// Keyboard gap (iOS 26 Safari, WebKit bug 297779): after the on-screen
// keyboard opens and closes, Safari can leave the window scrolled by the
// keyboard height, so the shell's scroll area ends mid-screen with blank space
// below. initViewportLock registers one window 'focusout' listener and one
// visualViewport 'resize' listener; when no text field is focused and the
// window is scrolled, it resets the window to 0,0. Nothing else is changed:
// no gesture is prevented and the viewport meta is untouched.
//
// Page mode on a phone or a touch tablet (src/lib/scroll-mode.ts pageScrollActive:
// html.scroll-page, every in-shell route but a chat thread (the chat list is
// page mode on a phone; all of Chat is locked on a touch tablet), AND
// PAGE_SCROLL_QUERY): the document itself scrolls, so a scrolled window is the person's
// own position and is never reset. A visualViewport resize there is the
// browser bars shrinking or growing, so it does nothing. Only the keyboard gap
// is mended: the window position at focusin on a text field is kept, and on
// focusout to a non-text target it is put back, and only when the root height
// shrank while the field was focused and has not recovered. Locked mode (a
// chat thread, auth, onboarding) and a laptop or an iPad with a trackpad (the class is set
// but the root is still the locked 100svh shell) keep the reset to 0,0 above.
//
// main.tsx calls it once at boot (mirroring initSentry / initTheme); a second
// call on the same window registers nothing.

import { pageScrollActive } from '@/lib/scroll-mode';

const registered = new WeakSet<object>();

const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

/** True when `el` is a field that raises the on-screen keyboard. */
export function isTextField(el: unknown): boolean {
  if (!el || typeof el !== 'object') return false;
  const node = el as { tagName?: unknown; type?: unknown; isContentEditable?: unknown };
  if (node.isContentEditable === true) return true;
  const tag = typeof node.tagName === 'string' ? node.tagName.toUpperCase() : '';
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = typeof node.type === 'string' ? node.type.toLowerCase() : 'text';
    return !NON_TEXT_INPUT_TYPES.has(type);
  }
  return false;
}

function resetIfUnfocused(focused: unknown): void {
  if (isTextField(focused)) return;
  if (pageScrollActive()) return;
  if (window.scrollY !== 0) window.scrollTo(0, 0);
}

/** The window position and root height when a text field took focus (page mode). */
export interface FocusSnapshot {
  top: number;
  rootHeight: number;
}

/**
 * Pure: the window position to put back when focus leaves text fields in page
 * mode, else null. Only when the root height shrank (the keyboard gap) and has
 * not recovered, and the window is not already there.
 */
export function focusRestoreTop(
  saved: FocusSnapshot | null,
  now: { top: number; rootHeight: number },
): number | null {
  if (saved === null) return null;
  if (now.rootHeight >= saved.rootHeight) return null;
  if (Math.abs(now.top - saved.top) <= 1) return null;
  return saved.top;
}

function rootHeight(): number {
  if (typeof document === 'undefined') return 0;
  return document.documentElement?.clientHeight ?? 0;
}

export function initViewportLock(): void {
  if (typeof window === 'undefined') return;
  if (registered.has(window)) return;
  registered.add(window);

  // Page mode only: the position before the keyboard, kept from the first
  // text field's focusin until focus leaves text fields.
  let saved: FocusSnapshot | null = null;
  window.addEventListener('focusin', (event) => {
    if (!pageScrollActive() || !isTextField(event.target)) return;
    if (saved === null) saved = { top: window.scrollY, rootHeight: rootHeight() };
  });

  // During focusout, activeElement is unreliable (still the leaving field in
  // some engines); relatedTarget is the element receiving focus, or null.
  window.addEventListener('focusout', (event) => {
    const next = (event as FocusEvent).relatedTarget;
    if (pageScrollActive()) {
      if (isTextField(next)) return;
      const top = focusRestoreTop(saved, { top: window.scrollY, rootHeight: rootHeight() });
      saved = null;
      if (top !== null) window.scrollTo(0, top);
      return;
    }
    saved = null;
    resetIfUnfocused(next);
  });

  const vv = window.visualViewport;
  if (vv) {
    vv.addEventListener('resize', () => {
      resetIfUnfocused(typeof document === 'undefined' ? null : document.activeElement);
    });
  }
}
