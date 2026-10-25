// The app's one chunk-error handler: main.tsx (boot imports), every lazy route
// and the agora SDK load all reload through reloadOnce() and its one guard.
// Route chunks are loaded with dynamic import(). A tab opened before a deploy
// asks for hashed chunks that no longer exist; the import rejects. Reload the
// page once so the fresh index.html and chunk names load. A sessionStorage
// flag bounds it to one reload per tab session: a second failure (or storage
// that throws) surfaces the error instead, so it can never loop.

import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

export const CHUNK_RELOAD_KEY = 'sorted:chunk-reload';

export interface ChunkReloadDeps {
  /** A getter because touching window.sessionStorage itself can throw. */
  storage: () => Pick<Storage, 'getItem' | 'setItem'>;
  reload: () => void;
}

const browserDeps: ChunkReloadDeps = {
  storage: () => window.sessionStorage,
  reload: () => window.location.reload(),
};

/**
 * A failed dynamic import is a TypeError in every browser ("Failed to fetch
 * dynamically imported module", "Importing a module script failed", "error
 * loading dynamically imported module"); Vite's preload helper rejects with
 * "Unable to preload CSS" when a chunk's stylesheet is gone.
 */
export function isChunkLoadError(err: unknown): boolean {
  return (
    err instanceof TypeError ||
    (err instanceof Error && err.message.startsWith('Unable to preload CSS'))
  );
}

/** Reload once per session. Returns true when a reload was issued. */
export function reloadOnce(deps: ChunkReloadDeps = browserDeps): boolean {
  try {
    const storage = deps.storage();
    if (storage.getItem(CHUNK_RELOAD_KEY) !== null) return false;
    storage.setItem(CHUNK_RELOAD_KEY, '1');
  } catch {
    // Storage unavailable: no guard means no reload.
    return false;
  }
  deps.reload();
  return true;
}

/**
 * Wrap a dynamic import: on a chunk load error, reload once and keep the
 * Suspense fallback up until the page goes; otherwise rethrow untouched.
 */
export function withChunkReload<T>(
  load: () => Promise<T>,
  deps: ChunkReloadDeps = browserDeps,
): () => Promise<T> {
  return () =>
    load().catch((err: unknown) => {
      if (isChunkLoadError(err) && reloadOnce(deps)) return new Promise<T>(() => {});
      throw err;
    });
}

/**
 * React.lazy over a dynamic import, with the one-time stale chunk reload.
 * `pick` names the component in the loaded module (pages use named exports).
 */
export function lazyRoute<M, P extends object>(
  load: () => Promise<M>,
  pick: (module: M) => ComponentType<P>,
): LazyExoticComponent<ComponentType<P>> {
  return lazy<ComponentType<P>>(
    withChunkReload(() => load().then((module) => ({ default: pick(module) }))),
  );
}

/** Run a task once the browser is idle (setTimeout fallback); returns a cancel. */
export function whenIdle(task: () => void, timeoutMs = 4000): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(task, { timeout: timeoutMs });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(task, 1);
  return () => window.clearTimeout(id);
}

/** The lazy signed-in shell unit (App.tsx renders it) and the Pipeline page chunk. */
export const loadShell = () =>
  Promise.all([
    import('@/lib/workspace-context'),
    import('@/lib/chat'),
    import('@/components/shell/AppLayout'),
  ]);
export const loadPipeline = () => import('@/components/pages/PipelinePage');

/** True when the browser asks to save data (Network Information API, where present). */
function saveData(): boolean {
  try {
    const nav = navigator as Navigator & { connection?: { saveData?: boolean } };
    return nav.connection?.saveData === true;
  } catch {
    return false;
  }
}

/**
 * Sign in, sign up and invite: once the page has painted and the browser is
 * idle, warm the shell and Pipeline chunks so the first signed-in screen is
 * cached. Code only: import() runs no data fetch, Supabase, auth or Agora
 * call (the SDK and the connection start only when the shell mounts).
 * Skipped under Save-Data. Returns a cancel for the effect cleanup.
 */
export function prefetchShellWhenIdle(): () => void {
  if (saveData()) return () => {};
  return whenIdle(() => {
    // A failed prefetch is harmless: the route's own lazy load retries and recovers.
    void loadShell().catch(() => undefined);
    void loadPipeline().catch(() => undefined);
  });
}
