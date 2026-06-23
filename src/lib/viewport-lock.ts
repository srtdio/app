// Locks the app to vertical scrolling on iOS by preventing the Safari-only
// multi-touch zoom/rotate gestures ('gesturestart'/'gesturechange'/'gestureend').
// iOS Safari ignores the viewport user-scalable/maximum-scale flags in-browser,
// so this is what actually stops pinch-zoom and two-finger rotate. Single-finger
// vertical scrolling and the horizontal chip rows are untouched because only the
// multi-touch gesture events are prevented (single-touch pan never fires them).

// These gesture events are Safari-only and absent from the DOM lib types, so we
// register them via the string-typed addEventListener overload with an
// (e: Event) => void handler to stay strict-clean (no `any`, no @ts-ignore).
function preventGesture(event: Event): void {
  event.preventDefault();
}

// App-lifetime listeners set once (mirroring initSentry/initTheme in main.tsx),
// so there is no teardown. { passive: false } is required for preventDefault to
// take effect on these gesture events.
export function initViewportLock(): void {
  document.addEventListener('gesturestart', preventGesture, { passive: false });
  document.addEventListener('gesturechange', preventGesture, { passive: false });
  document.addEventListener('gestureend', preventGesture, { passive: false });
}
