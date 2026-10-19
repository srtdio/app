// Pinch zoom is allowed. This module used to cancel Safari's multi-touch
// gesture events ('gesturestart'/'gesturechange'/'gestureend') to lock the
// page at 1x; that also took away the accessibility zoom people rely on, so
// it no longer does. iOS zoom-on-focus is prevented at the source instead:
// every text field is 16px below md (Input, Textarea, the Select trigger), and
// the viewport meta no longer sets maximum-scale or user-scalable.
//
// Kept as the app-lifetime init main.tsx calls (mirroring initSentry /
// initTheme) so the boot sequence is unchanged; it registers nothing.

export function initViewportLock(): void {
  // Intentionally empty: no gesture is prevented, pinch zoom works.
}
