// The app's one chunk-error handler: main.tsx (boot imports), every lazy route
// and the agora SDK load all reload through reloadIfStale() and its one guard.
// Route chunks are loaded with dynamic import(). A tab opened before a deploy
// asks for hashed chunks that no longer exist; the import rejects. The page
// reloads only when that is proven: the failed module's URL is read from the
// error and a HEAD request for it answers 404 or 410. Anything else (no URL,
// another status, a network error, a timeout, the page being left) rethrows.
// A sessionStorage flag bounds it to one reload per tab session: a second
// failure (or storage that throws) surfaces the error instead, so it can never
// loop.

import { createElement, lazy, useState, type ComponentType, type ReactElement } from 'react';

export const CHUNK_RELOAD_KEY = 'sorted:chunk-reload';

/** How long the stale check waits for the HEAD response before giving up. */
const STALE_PROBE_TIMEOUT_MS = 3000;

export interface ChunkReloadDeps {
  /** A getter because touching window.sessionStorage itself can throw. */
  storage: () => Pick<Storage, 'getItem' | 'setItem'>;
  reload: () => void;
  /** True while the page is being left; imports in flight then fail by design. */
  isLeaving?: () => boolean;
  /** HEAD the URL; resolves the HTTP status, or null on a network error or timeout. */
  probe?: (url: string) => Promise<number | null>;
  /** The page URL module URLs resolve against; only same-origin URLs are probed. */
  baseUrl?: () => string;
}

// Leaving the page (a link, a typed URL, a test's page.goto) aborts every
// import still in flight, and the abort rejects like a missing chunk. In WebKit
// it can reject before pagehide fires, so the stale check also watches
// beforeunload and a hidden page. Reloading then would hijack the navigation
// back to this page, so a page being left never reloads. A page restored from
// the back/forward cache clears the flag.
let leaving = false;
// Errors Vite reported through vite:preloadError (its preload helper's failures).
const preloadErrors = new WeakSet<object>();
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    leaving = true;
  });
  window.addEventListener('beforeunload', () => {
    leaving = true;
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) leaving = false;
  });
  window.addEventListener('vite:preloadError', (event) => {
    const payload: unknown = (event as Event & { payload?: unknown }).payload;
    if (typeof payload === 'object' && payload !== null) preloadErrors.add(payload);
  });
}

function pageIsLeaving(): boolean {
  return leaving || (typeof document !== 'undefined' && document.visibilityState === 'hidden');
}

/**
 * HEAD a same-origin static file, bypassing the cache. XMLHttpRequest, not
 * fetchWithTrace: this runs in the boot path before the logger loads, and on a
 * stale deploy a dynamic import of the wrapper could itself be the missing chunk.
 * It reads a static asset, not an API, so it carries no trace id.
 */
function headStatus(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('HEAD', url);
      xhr.timeout = STALE_PROBE_TIMEOUT_MS;
      xhr.setRequestHeader('Cache-Control', 'no-store');
      xhr.onload = () => resolve(xhr.status === 0 ? null : xhr.status);
      xhr.onerror = () => resolve(null);
      xhr.ontimeout = () => resolve(null);
      xhr.onabort = () => resolve(null);
      xhr.send();
    } catch {
      resolve(null);
    }
  });
}

const browserDeps: ChunkReloadDeps = {
  storage: () => window.sessionStorage,
  reload: () => window.location.reload(),
  isLeaving: pageIsLeaving,
  probe: headStatus,
  baseUrl: () => window.location.href,
};

// The messages a failed module load rejects with, per engine: Chromium
// ("Failed to fetch dynamically imported module: URL"), Firefox ("error loading
// dynamically imported module: URL"), WebKit ("Importing a module script
// failed.") and Vite's preload helper ("Unable to preload CSS for URL").
const CHUNK_MESSAGES = [
  /Failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /Importing a module script failed/i,
  /^Unable to preload CSS/,
];

// The module URL inside a Chromium, Firefox or Vite preload message.
const MODULE_URL = /(?:dynamically imported module|Unable to preload CSS for):?\s+(\S+)/i;

/**
 * A failed module load: one of the known engine messages, or an error Vite
 * reported through vite:preloadError. A plain TypeError (an aborted fetch,
 * "Load failed") no longer qualifies.
 */
export function isChunkLoadError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (preloadErrors.has(err)) return true;
  return CHUNK_MESSAGES.some((pattern) => pattern.test(err.message));
}

/** The failed module's absolute same-origin URL, or null when the error names none. */
export function chunkUrlFromError(err: unknown, base: string): string | null {
  if (!(err instanceof Error)) return null;
  const match = MODULE_URL.exec(err.message);
  const raw = match?.[1];
  if (raw === undefined) return null;
  try {
    const url = new URL(raw, base);
    if (url.origin !== new URL(base).origin) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Reload once per session. Returns true when a reload was issued. */
export function reloadOnce(deps: ChunkReloadDeps = browserDeps): boolean {
  if (deps.isLeaving?.() === true) return false;
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
 * Try again on a page chunk still loading after CHUNK_WAIT_MS: the one
 * guarded reload. Once the guard is spent the tap still reloads, since a
 * person's tap cannot loop.
 */
export function reloadForChunkWait(deps: ChunkReloadDeps = browserDeps): void {
  if (!reloadOnce(deps)) deps.reload();
}

/**
 * Reload once only when the error proves a stale build: it is a chunk load
 * error, it names the module's URL, and a HEAD for that URL answers 404 or
 * 410 while the page is not being left. Resolves true when a reload was issued.
 */
export async function reloadIfStale(
  err: unknown,
  deps: ChunkReloadDeps = browserDeps,
): Promise<boolean> {
  if (!isChunkLoadError(err) || deps.probe === undefined) return false;
  if (deps.isLeaving?.() === true) return false;
  const base = deps.baseUrl?.() ?? (typeof window !== 'undefined' ? window.location.href : '');
  const url = chunkUrlFromError(err, base);
  if (url === null) return false;
  let status: number | null;
  try {
    status = await deps.probe(url);
  } catch {
    return false;
  }
  // Leaving while the check ran: the abort was the cause, not a stale build.
  if (deps.isLeaving?.() === true) return false;
  if (status !== 404 && status !== 410) return false;
  return reloadOnce(deps);
}

/**
 * Wrap a dynamic import: on a proven stale chunk, reload once and keep the
 * Suspense fallback up until the page goes; otherwise rethrow untouched.
 */
export function withChunkReload<T>(
  load: () => Promise<T>,
  deps: ChunkReloadDeps = browserDeps,
): () => Promise<T> {
  return () =>
    load().catch(async (err: unknown) => {
      if (isChunkLoadError(err)) {
        // Leaving: the import was aborted, the page is going; keep the fallback up.
        if (deps.isLeaving?.() === true) return new Promise<T>(() => {});
        if (await reloadIfStale(err, deps)) return new Promise<T>(() => {});
      }
      throw err;
    });
}

// Each page's import() goes through one memoized loader (chunkLoader), which
// records the module once it lands. A route whose module has already landed
// (the boot start in main.tsx, a nav press, the idle prefetch) renders it
// directly on mount instead of through React.lazy, whose first render always
// suspends for a tick even on a loaded module: the Suspense fallback never
// flashes for a page whose code is already here.
const loadedModules = new WeakMap<() => Promise<unknown>, unknown>();

/**
 * One page chunk's loader: the import() runs once (a failure is forgotten, so
 * the next call retries) and the landed module is recorded for loadedChunk.
 */
export function chunkLoader<M>(load: () => Promise<M>): () => Promise<M> {
  let pending: Promise<M> | null = null;
  const loader = (): Promise<M> => {
    if (pending === null) {
      const started = load().then(
        (module) => {
          loadedModules.set(loader, module);
          return module;
        },
        (err: unknown) => {
          if (pending === started) pending = null;
          throw err;
        },
      );
      pending = started;
    }
    return pending;
  };
  return loader;
}

/** The module a chunkLoader already loaded, or undefined (not asked, running or failed). */
export function loadedChunk<M>(load: () => Promise<M>): M | undefined {
  return loadedModules.get(load) as M | undefined;
}

/**
 * React.lazy over a dynamic import, with the one-time stale chunk reload.
 * `pick` names the component in the loaded module (pages use named exports).
 * When `load` is a chunkLoader whose module has landed, a mount renders the
 * page directly (no Suspense tick); the choice is made once per mount, so a
 * mounted page never swaps component type (no remount).
 */
export function lazyRoute<M, P extends object>(
  load: () => Promise<M>,
  pick: (module: M) => ComponentType<P>,
): ComponentType<P> {
  let picked: ComponentType<P> | undefined;
  const pickOnce = (module: M): ComponentType<P> => {
    picked ??= pick(module);
    return picked;
  };
  const Lazy = lazy<ComponentType<P>>(
    withChunkReload(() => load().then((module) => ({ default: pickOnce(module) }))),
  ) as unknown as ComponentType<P>;
  function LazyRoute(props: P): ReactElement {
    const [Component] = useState<ComponentType<P>>(() => {
      const module = loadedChunk(load);
      return module === undefined ? Lazy : pickOnce(module);
    });
    return createElement(Component, props);
  }
  return LazyRoute;
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

// The shell unit, the Pipeline chunk (the signed-out pages warm both:
// prefetchShellWhenIdle) and the primary nav's pages. Every other page's
// loader lives in src/lib/page-loaders.ts, which only App.tsx and main.tsx
// import, so the shell and the chat SDK load never link every page.

/** The lazy signed-in shell unit (App.tsx renders it). */
export const loadShell = chunkLoader(() =>
  Promise.all([
    import('@/lib/workspace-context'),
    import('@/lib/chat'),
    import('@/components/shell/AppLayout'),
  ]),
);
export const loadPipeline = chunkLoader(() => import('@/components/pages/PipelinePage'));
// The primary nav's other pages: the nav press prefetch (route-prefetch.ts)
// starts them from the shell, which already links them.
export const loadChat = chunkLoader(() => import('@/components/pages/ChatPage'));
export const loadBriefs = chunkLoader(() => import('@/components/pages/BriefsPage'));
export const loadAssets = chunkLoader(() => import('@/components/pages/AssetsPage'));
export const loadPlanTab = chunkLoader(() => import('@/components/pages/PlanTabPage'));
/** The tiny layout Activity and the Plan tab render in (without the Plan screen). */
export const loadPlanBeside = chunkLoader(() => import('@/components/pages/PlanBesideLayout'));
type RouteChunkTable = (pathname: string) => readonly (() => Promise<unknown>)[];

// The route table (page-loaders.ts sets it when it loads, before the shell
// mounts). Until then no path has chunks to wait for.
let routeChunkTable: RouteChunkTable = () => [];

/** page-loaders.ts: the chunks each signed-in path renders. */
export function setRouteChunkTable(table: RouteChunkTable): void {
  routeChunkTable = table;
}

/** True once every chunk the path renders has landed (a path with none is ready). */
export function routeChunksLoaded(pathname: string): boolean {
  return routeChunkTable(pathname).every((load) => loadedChunk(load) !== undefined);
}

/** The longest a page chunk holds a loader (the shell's first route, a Suspense fallback). */
export const CHUNK_WAIT_MS = 10_000;

/**
 * Settles (never rejects) once every chunk the path renders has landed or
 * failed, or after `capMs`, whichever is first. The chunks keep loading.
 */
export function whenRouteChunksSettle(
  pathname: string,
  capMs: number = CHUNK_WAIT_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, capMs);
  });
  const settled = Promise.allSettled(routeChunkTable(pathname).map((load) => load())).then(
    () => undefined,
  );
  return Promise.race([settled, cap]).finally(() => clearTimeout(timer));
}

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
