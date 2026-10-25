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

/** React.lazy over a dynamic import, with the one-time stale chunk reload. */
export function lazyRoute<P extends object>(
  load: () => Promise<{ default: ComponentType<P> }>,
): LazyExoticComponent<ComponentType<P>> {
  return lazy(withChunkReload(load));
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
