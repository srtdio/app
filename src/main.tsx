import { installDomMutationGuard } from '@/lib/dom-mutation-guard';
import { mark } from '@/lib/perf-marks';
import { StrictMode } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import {
  hasStoredSession,
  isGuestHome,
  isHomeBundlePath,
  localStorageKeys,
} from '@/components/home/guest-path';
import {
  APP_STYLESHEET,
  HOME_STYLESHEET,
  browserStaleDeployDeps,
  runStaleDeployGuard,
  type StaleDeployWarn,
} from '@/lib/stale-deploy';
import { reloadIfStale } from '@/lib/chunk-reload';
import { startBootChunks } from '@/lib/page-loaders';
import { captureEarlyErrors, scheduleSentry } from '@/lib/sentry-lazy';

// Entry point. Decides synchronously whether "/" is a guest visit; a guest gets
// the homepage chunk only (no App, router, Supabase, Sentry, Agora or app CSS).
// Everyone else gets the app, booted exactly as before.

// Before any render: absorb foreign DOM moves (Translate, extensions) so
// React's removeChild/insertBefore cannot crash the app (FRONTEND-N).
installDomMutationGuard();

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root not found');
}

// The logger pulls in Sentry, so the guest path only loads it if it must warn.
const lazyWarn: StaleDeployWarn = (message, context) => {
  void import('@/lib/logger').then(({ logger }) => logger.warn(message, context));
};

// A stale tab can ask for chunks that no longer exist after a deploy. A failed
// boot import goes through the app's one chunk-error handler: it reloads once
// per session (shared guard) only when the missing chunk is proven stale (HEAD
// 404 or 410). Anything else (a config error, a bug, an aborted import) is
// rethrown.
async function recoverFromFailedBoot(err: unknown): Promise<void> {
  if (await reloadIfStale(err)) return;
  throw err;
}

async function bootApp(root: HTMLElement): Promise<void> {
  // A stored session (supabase-js's sb-*-auth-token key exists; its value is
  // not read here) means the signed-in shell is next: start its chunk and the
  // current route's chunk now, in parallel with the app chunk and getSession,
  // instead of after the session resolves. Code only, no data.
  mark('boot:app:start');
  // Sentry loads after first render; until then uncaught errors are kept here.
  captureEarlyErrors();
  if (hasStoredSession(localStorageKeys)) {
    startBootChunks(window.location.pathname);
    // The saved screens (IndexedDB) load in parallel with the imports below;
    // nothing waits on them. Ready before the first render, they paint it.
    void import('@/lib/device-cache')
      .then(({ storedSessionUserId }) => {
        const userId = storedSessionUserId();
        if (userId === null) return undefined;
        return import('@/lib/session-read').then(({ hydrateSessionReads }) =>
          hydrateSessionReads(userId),
        );
      })
      .catch(() => undefined);
  }
  // index.css is requested first so its <link> keeps today's cascade order.
  // Each import is destructured where it is made so Rollup can still
  // tree-shake the modules. Sentry is not here: scheduleSentry loads it after
  // render.
  const [, BootErrorBoundary, App, TraceProvider, initTheme, initViewportLock, logger] =
    await Promise.all([
      import('@/index.css'),
      import('@/components/shell/BootErrorBoundary').then(
        ({ BootErrorBoundary }) => BootErrorBoundary,
      ),
      import('@/App').then(({ default: App }) => App),
      import('@/lib/trace-context').then(({ TraceProvider }) => TraceProvider),
      import('@/lib/theme').then(({ initTheme }) => initTheme),
      import('@/lib/viewport-lock').then(({ initViewportLock }) => initViewportLock),
      import('@/lib/logger').then(({ logger }) => logger),
    ]);
  mark('boot:app:imports');

  initTheme();
  initViewportLock();

  // Render only once the stylesheet is confirmed applied; on a stale deploy the
  // guard reloads the page instead (at most once per session).
  const shouldRender = await runStaleDeployGuard(
    browserStaleDeployDeps(APP_STYLESHEET, (message, context) => logger.warn(message, context)),
  );
  mark('boot:app:cssguard');
  if (!shouldRender) return;

  mark('boot:app:render');
  createRoot(root).render(
    <StrictMode>
      <BootErrorBoundary>
        <TraceProvider>
          <App />
        </TraceProvider>
      </BootErrorBoundary>
    </StrictMode>,
  );
  scheduleSentry();
}

async function bootHome(root: HTMLElement): Promise<void> {
  const { HomeEntry, scheduleSentry } = await import('@/components/home/HomeEntry');
  mark('boot:home:chunk');
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
  mark('boot:home:hydrate');
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

mark('boot:path');
if (guest || isHomeBundlePath(window.location.pathname)) {
  bootHome(rootElement).catch(recoverFromFailedBoot);
} else {
  bootApp(rootElement).catch(recoverFromFailedBoot);
}
