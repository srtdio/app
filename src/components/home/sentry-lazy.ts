// Sentry for the guest homepage path. The SDK (and src/lib/env.ts) loads after
// first paint so it never delays the homepage; errors caught before then are
// reported once it has loaded.

type SentryModule = typeof import('@/lib/sentry');

let loading: Promise<SentryModule> | null = null;

function loadSentry(): Promise<SentryModule> {
  loading ??= import('@/lib/sentry').then((mod) => {
    mod.initSentry();
    return mod;
  });
  return loading;
}

/** Initialises Sentry when the browser is idle (setTimeout where unsupported). */
export function scheduleSentry(): void {
  const start = (): void => {
    void loadSentry().catch(() => undefined);
  };
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(start, { timeout: 4000 });
  } else {
    window.setTimeout(start, 1500);
  }
}

export function reportError(err: unknown, context?: Record<string, unknown>): void {
  void loadSentry()
    .then((mod) => mod.captureException(err, context))
    .catch(() => undefined);
}
