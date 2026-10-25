import { StrictMode } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { isGuestHome, isHomeBundlePath, localStorageKeys } from '@/components/home/guest-path';
import {
  APP_STYLESHEET,
  HOME_STYLESHEET,
  browserStaleDeployDeps,
  runStaleDeployGuard,
  type StaleDeployWarn,
} from '@/lib/stale-deploy';
import { isChunkLoadError, reloadOnce } from '@/lib/chunk-reload';

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

// A stale tab can ask for chunks that no longer exist after a deploy. A failed
// boot import goes through the app's one chunk-error handler (reload once per
// session, shared guard). Anything else (a config error, a bug) is rethrown.
function recoverFromFailedBoot(err: unknown): void {
  if (isChunkLoadError(err) && reloadOnce()) return;
  throw err;
}

function ErrorFallback() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-bg text-fg">
      <span className="text-legacy-sm">Something went wrong. Refresh to try again.</span>
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
  const { HomeEntry, scheduleSentry } = await import('@/components/home/HomeEntry');
  const shouldRender = await runStaleDeployGuard(browserStaleDeployDeps(HOME_STYLESHEET, lazyWarn));
  if (!shouldRender) return;

  const page = (
    <StrictMode>
      <HomeEntry />
    </StrictMode>
  );
  // Built pages arrive prerendered (scripts/prerender.ts): hydrate that markup
  // in place. A mismatch (the /demo calendar's "today" after the build date)
  // makes React re-render on the client; it is logged once, not thrown.
  if (root.hasChildNodes()) {
    let reported = false;
    hydrateRoot(root, page, {
      onRecoverableError: (err) => {
        if (reported) return;
        reported = true;
        lazyWarn('home hydration fell back to client render', {
          path: window.location.pathname,
          error: err instanceof Error ? err.message : String(err),
        });
      },
    });
  } else {
    createRoot(root).render(page);
  }
  scheduleSentry();
}

const guest = isGuestHome({
  pathname: window.location.pathname,
  search: window.location.search,
  hash: window.location.hash,
  storageKeys: localStorageKeys,
});

if (guest || isHomeBundlePath(window.location.pathname)) {
  bootHome(rootElement).catch(recoverFromFailedBoot);
} else {
  bootApp(rootElement).catch(recoverFromFailedBoot);
}
