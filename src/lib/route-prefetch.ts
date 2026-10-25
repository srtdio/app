// Nav prefetch: a press on a nav item (pointerdown, touchstart) starts the
// import() of that route's chunk, so the page code is on its way before the
// click lands. Code only: import() runs no data fetch, Supabase or Agora call.
// App.tsx's lazy routes use these same loader functions, so Vite resolves one
// chunk per page and the route's own lazy load reuses the module already
// fetched. Once per route per session; a failed prefetch is logged and
// swallowed (the route's own lazy load retries and owns the reload guard).

import { loadPipeline } from '@/lib/chunk-reload';
import { logger } from '@/lib/logger';

export { loadPipeline };
export const loadChat = () => import('@/components/pages/ChatPage');
export const loadBriefs = () => import('@/components/pages/BriefsPage');
export const loadAssets = () => import('@/components/pages/AssetsPage');
export const loadPlanTab = () => import('@/components/pages/PlanTabPage');
export const loadPlan = () => import('@/components/pages/PlanPage');

type Loader = () => Promise<unknown>;

/** The primary nav's paths (src/components/shell/nav.ts) and the chunks each route renders. */
export const NAV_ROUTE_LOADERS: Readonly<Record<string, readonly Loader[]>> = {
  '/pipeline': [loadPipeline],
  '/briefs': [loadBriefs],
  '/assets': [loadAssets],
  '/chat': [loadChat],
  // The Plan tab renders inside PlanBesideLayout (PlanPage's chunk).
  '/plan': [loadPlanTab, loadPlan],
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

/** Forget which routes were prefetched (tests). */
export function resetRoutePrefetch(): void {
  prefetched.clear();
}

/** Spread on a nav item: a press (mouse, pen or touch) prefetches its route's code. */
export function navPrefetchProps(path: string): {
  onPointerDown: () => void;
  onTouchStart: () => void;
} {
  const prefetch = (): void => {
    prefetchRoute(path);
  };
  return { onPointerDown: prefetch, onTouchStart: prefetch };
}
