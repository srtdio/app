// Sentry for the signed-in app path. The SDK loads when the browser is idle
// after first render, so vendor-sentry never sits on the critical path.
// Uncaught errors and rejections that happen before then are kept (at most
// MAX_EARLY_ERRORS) and forwarded once Sentry initialises; then the listeners
// are removed and Sentry's own global handlers take over.
//
// Imports nothing statically, so main.tsx can register the listeners before
// render without adding to the entry chunk.

export const MAX_EARLY_ERRORS = 20;

const early: unknown[] = [];
let listening = false;

function keep(err: unknown): void {
  if (early.length < MAX_EARLY_ERRORS) early.push(err);
}

function onError(event: ErrorEvent): void {
  keep(event.error ?? new Error(event.message));
}

function onRejection(event: PromiseRejectionEvent): void {
  keep(event.reason);
}

function stopListening(): void {
  if (!listening) return;
  listening = false;
  window.removeEventListener('error', onError);
  window.removeEventListener('unhandledrejection', onRejection);
}

/** Registers the early error listeners. Call before render. */
export function captureEarlyErrors(): void {
  if (listening) return;
  listening = true;
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
}

async function startSentry(): Promise<void> {
  const { initSentry, captureException } = await import('@/lib/sentry');
  const live = await initSentry();
  stopListening();
  const errors = early.splice(0);
  if (!live) return;
  for (const err of errors) captureException(err, { before_sentry_init: true });
}

/** Initialises Sentry when the browser is idle (setTimeout where unsupported). */
export function scheduleSentry(): void {
  const start = (): void => {
    void startSentry().catch(() => stopListening());
  };
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(start, { timeout: 4000 });
  } else {
    window.setTimeout(start, 1500);
  }
}
