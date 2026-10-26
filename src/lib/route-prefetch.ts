// Nav prefetch: a press on a nav item (pointerdown, touchstart) starts the
// import() of that route's chunk, so the page code is on its way before the
// click lands. The same press starts the route's first reads through
// src/lib/route-data.ts (data); the import() itself runs no fetch.
// App.tsx's lazy routes use these same loader functions, so Vite resolves one
// chunk per page and the route's own lazy load reuses the module already
// fetched. Once per route per session; a failed prefetch is logged and
// swallowed (the route's own lazy load retries and owns the reload guard).

import {
  loadAssets,
  loadBriefDetail,
  loadBriefRefResolver,
  loadBriefs,
  loadChat,
  loadHelp,
  loadNotifications,
  loadPipeline,
  loadPlan,
  loadPlanBeside,
  loadPlanTab,
  loadPostDetail,
  loadPostRefResolver,
  loadRecentlyDeleted,
  loadSettings,
} from '@/lib/chunk-reload';
import { logger } from '@/lib/logger';
import { prefetchRouteData } from '@/lib/route-data';

// The loaders are defined in chunk-reload.ts (main.tsx starts them at boot,
// before the logger loads) and re-exported here, the one place App.tsx and the
// shell take them from.
export {
  loadAssets,
  loadBriefDetail,
  loadBriefRefResolver,
  loadBriefs,
  loadChat,
  loadHelp,
  loadNotifications,
  loadPipeline,
  loadPlan,
  loadPlanBeside,
  loadPlanTab,
  loadPostDetail,
  loadPostRefResolver,
  loadRecentlyDeleted,
  loadSettings,
};

type Loader = () => Promise<unknown>;

/** The primary nav's paths (src/components/shell/nav.ts) and the chunks each route renders. */
export const NAV_ROUTE_LOADERS: Readonly<Record<string, readonly Loader[]>> = {
  '/pipeline': [loadPipeline],
  '/briefs': [loadBriefs],
  '/assets': [loadAssets],
  '/chat': [loadChat],
  // The Plan tab renders inside PlanBesideLayout (its own tiny chunk).
  '/plan': [loadPlanTab, loadPlanBeside],
};

const prefetched = new Set<string>();

/**
 * Start loading a nav route's chunks, once per route per session. Returns true
 * when this call started the loads (false: already asked, or not a nav route).
 */
export function prefetchRoute(
  path: string,
  loaders: Readonly<Record<string, readonly Loader[]>> = NAV_ROUTE_LOADERS,
): boolean {
  const load = loaders[path];
  if (load === undefined || prefetched.has(path)) return false;
  prefetched.add(path);
  for (const loader of load) {
    try {
      void loader().catch((err: unknown) => {
        logger.warn('route prefetch failed', { path, error: String(err) });
      });
    } catch (err: unknown) {
      logger.warn('route prefetch failed', { path, error: String(err) });
    }
  }
  return true;
}

/**
 * Every page chunk the shell can open, warmed once the signed-in shell is idle
 * after first paint (App.tsx). Code only: an import() runs no data fetch.
 */
export const IDLE_PREFETCH_LOADERS: readonly Loader[] = [
  loadPipeline,
  loadChat,
  loadBriefs,
  loadAssets,
  loadPlanTab,
  loadPlanBeside,
  loadPlan,
  loadNotifications,
  loadPostDetail,
  loadBriefDetail,
  loadPostRefResolver,
  loadBriefRefResolver,
  loadSettings,
  loadHelp,
  loadRecentlyDeleted,
];

/** Start every loader (idle prefetch); a failure is logged and swallowed. */
export function prefetchChunks(loaders: readonly Loader[] = IDLE_PREFETCH_LOADERS): void {
  for (const loader of loaders) {
    try {
      void loader().catch((err: unknown) => {
        logger.warn('idle prefetch failed', { error: String(err) });
      });
    } catch (err: unknown) {
      logger.warn('idle prefetch failed', { error: String(err) });
    }
  }
}

/** Forget which routes were prefetched (tests). */
export function resetRoutePrefetch(): void {
  prefetched.clear();
}

/**
 * Spread on a nav item: a press (mouse, pen or touch) prefetches its route's
 * code and starts its first reads (src/lib/route-data.ts).
 */
export function navPrefetchProps(path: string): {
  onPointerDown: () => void;
  onTouchStart: () => void;
} {
  const prefetch = (): void => {
    prefetchRoute(path);
    prefetchRouteData(path);
  };
  return { onPointerDown: prefetch, onTouchStart: prefetch };
}

/**
 * Spread on the Activity bell: a press loads the Activity chunk (and the
 * layout it renders in) and starts its first reads.
 */
export function activityPrefetchProps(): { onPointerDown: () => void; onTouchStart: () => void } {
  const prefetch = (): void => {
    prefetchChunks([loadPlanBeside, loadNotifications]);
    prefetchRouteData('/notifications');
  };
  return { onPointerDown: prefetch, onTouchStart: prefetch };
}

/**
 * Spread on the avatar button: a press loads the Settings chunk and starts the
 * members read the Settings members panel joins (route-data's '/settings').
 */
export function settingsPrefetchProps(): { onPointerDown: () => void; onTouchStart: () => void } {
  const prefetch = (): void => {
    prefetchChunks([loadSettings]);
    prefetchRouteData('/settings');
  };
  return { onPointerDown: prefetch, onTouchStart: prefetch };
}
