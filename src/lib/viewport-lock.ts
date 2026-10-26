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
// main.tsx calls it once at boot (mirroring initSentry / initTheme); a second
// call on the same window registers nothing.

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
  if (window.scrollY !== 0) window.scrollTo(0, 0);
}

export function initViewportLock(): void {
  if (typeof window === 'undefined') return;
  if (registered.has(window)) return;
  registered.add(window);

  // During focusout, activeElement is unreliable (still the leaving field in
  // some engines); relatedTarget is the element receiving focus, or null.
  window.addEventListener('focusout', (event) => {
    resetIfUnfocused((event as FocusEvent).relatedTarget);
  });

  const vv = window.visualViewport;
  if (vv) {
    vv.addEventListener('resize', () => {
      resetIfUnfocused(typeof document === 'undefined' ? null : document.activeElement);
    });
  }
}
