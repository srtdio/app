import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { isGuestHome, localStorageKeys, paintGuestCanvas } from '@/components/home/guest-path';
import {
  APP_STYLESHEET,
  HOME_STYLESHEET,
  browserStaleDeployDeps,
  runStaleDeployGuard,
  type StaleDeployWarn,
  type StylesheetTarget,
} from '@/lib/stale-deploy';

// Entry point. Decides synchronously whether "/" is a guest visit; a guest gets
// the homepage chunk only (no App, router, Supabase, Sentry, Agora or app CSS).
// Everyone else gets the app, booted exactly as before.

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root not found');
}

// The logger pulls in Sentry, so the guest path only loads it if it must warn.
const lazyWarn: StaleDeployWarn = (message, context) => {
  void import('@/lib/logger').then(({ logger }) => logger.warn(message, context));
};

// A failed dynamic import surfaces as a TypeError in every browser; Vite's
// preload helper rejects with this message when a chunk's CSS fails to load.
function isChunkLoadError(err: unknown): boolean {
  return (
    err instanceof TypeError ||
    (err instanceof Error && err.message.startsWith('Unable to preload CSS'))
  );
}

// A stale tab can ask for chunks that no longer exist after a deploy. Treat a
// failed boot import like an unstyled load: reload once with the same guard.
// Anything else (a config error, a bug) is rethrown untouched.
function recoverFromFailedBoot(target: StylesheetTarget, err: unknown): void {
  if (!isChunkLoadError(err)) throw err;
  void runStaleDeployGuard({
    ...browserStaleDeployDeps(target, lazyWarn),
    stylesheet: null,
    readToken: () => '',
  });
}

function ErrorFallback() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-bg text-fg">
      <span className="text-sm">Something went wrong. Refresh to try again.</span>
    </main>
  );
}

async function bootApp(root: HTMLElement): Promise<void> {
  // index.css is requested first so its <link> keeps today's cascade order.
  // Each import is destructured where it is made so Rollup can still
  // tree-shake the modules (a bare namespace import would keep all of Sentry).
  const [, ErrorBoundary, App, initSentry, TraceProvider, initTheme, initViewportLock, logger] =
    await Promise.all([
      import('@/index.css'),
      import('@sentry/react').then(({ ErrorBoundary }) => ErrorBoundary),
      import('@/App').then(({ default: App }) => App),
      import('@/lib/sentry').then(({ initSentry }) => initSentry),
      import('@/lib/trace-context').then(({ TraceProvider }) => TraceProvider),
      import('@/lib/theme').then(({ initTheme }) => initTheme),
      import('@/lib/viewport-lock').then(({ initViewportLock }) => initViewportLock),
      import('@/lib/logger').then(({ logger }) => logger),
    ]);

  initSentry();
  initTheme();
  initViewportLock();

  // Render only once the stylesheet is confirmed applied; on a stale deploy the
  // guard reloads the page instead (at most once per session).
  const shouldRender = await runStaleDeployGuard(
    browserStaleDeployDeps(APP_STYLESHEET, (message, context) => logger.warn(message, context)),
  );
  if (!shouldRender) return;

  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary fallback={<ErrorFallback />}>
        <TraceProvider>
          <App />
        </TraceProvider>
      </ErrorBoundary>
    </StrictMode>,
  );
}

async function bootHome(root: HTMLElement): Promise<void> {
  paintGuestCanvas();
  const { HomeEntry, scheduleSentry } = await import('@/components/home/HomeEntry');
  const shouldRender = await runStaleDeployGuard(browserStaleDeployDeps(HOME_STYLESHEET, lazyWarn));
  if (!shouldRender) return;

  createRoot(root).render(
    <StrictMode>
      <HomeEntry />
    </StrictMode>,
  );
  scheduleSentry();
}

const guest = isGuestHome({
  pathname: window.location.pathname,
  search: window.location.search,
  hash: window.location.hash,
  storageKeys: localStorageKeys,
});

if (guest) {
  bootHome(rootElement).catch((err: unknown) => recoverFromFailedBoot(HOME_STYLESHEET, err));
} else {
  bootApp(rootElement).catch((err: unknown) => recoverFromFailedBoot(APP_STYLESHEET, err));
}
