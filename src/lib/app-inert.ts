// While a modal layer is open, the app root (#root) is aria-hidden: screen
// readers cannot reach the page behind the sheet or dialog (Tab is already
// kept in the layer by useModalFocus). Not the `inert` attribute: an action in
// a sheet often hands focus to the page as it closes (Reply and Talk about
// focus the composer), and an inert root refuses that focus. Modal layers render
// in a portal on <body>, outside #root, so they stay live. Refcounted: nested
// modals (a confirm over a sheet) hold it together and the root wakes only when
// the last one closes. A modal that renders inside #root itself never holds it
// (it would freeze its own panel). useModalFocus is the one caller, so every
// Sheet, dialog and viewer gets it with no per-screen code.

const APP_ROOT_ID = 'root';

let holds = 0;

function appRoot(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  return document.getElementById(APP_ROOT_ID);
}

function apply(): void {
  const root = appRoot();
  if (root === null) return;
  if (holds > 0) root.setAttribute('aria-hidden', 'true');
  else root.removeAttribute('aria-hidden');
}

/**
 * Hold the app root inert for a modal whose panel is `panel`. Returns the
 * release (idempotent). A panel inside #root (or no #root at all) is a no-op.
 */
export function holdAppInert(panel: HTMLElement | null): () => void {
  const root = appRoot();
  if (root === null || panel === null || root.contains(panel)) return () => undefined;
  holds += 1;
  apply();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds = Math.max(0, holds - 1);
    apply();
  };
}

/** Open holds right now (tests and diagnostics). */
export function appInertHolds(): number {
  return holds;
}
