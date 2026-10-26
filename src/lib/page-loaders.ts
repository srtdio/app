// Every signed-in page's chunk loader, one named function each: App.tsx's lazy
// routes, the nav press prefetch and the idle prefetch (src/lib/route-prefetch.ts)
// and the boot start below all call the same function, so the chunk is asked
// for once and the route renders it directly once it has landed. Only App.tsx
// and main.tsx import this file (it links every page); the shell's press
// prefetch takes the loaders it needs beyond the nav from prefetch-context.ts,
// where App.tsx registers them.

import {
  chunkLoader,
  loadAssets,
  loadBriefs,
  loadChat,
  loadPipeline,
  loadPlanBeside,
  loadPlanTab,
  loadShell,
  routeChunksLoaded,
  setRouteChunkTable,
  whenRouteChunksSettle,
} from '@/lib/chunk-reload';

export {
  loadAssets,
  loadBriefs,
  loadChat,
  loadPipeline,
  loadPlanBeside,
  loadPlanTab,
  loadShell,
  routeChunksLoaded,
  whenRouteChunksSettle,
};

export const loadPlan = chunkLoader(() => import('@/components/pages/PlanPage'));
export const loadPostDetail = chunkLoader(() => import('@/components/pages/PostDetailPage'));
export const loadBriefDetail = chunkLoader(() => import('@/components/pages/BriefDetailPage'));
export const loadSettings = chunkLoader(() => import('@/components/pages/SettingsPage'));
export const loadHelp = chunkLoader(() => import('@/components/pages/HelpPage'));
export const loadRecentlyDeleted = chunkLoader(
  () => import('@/components/pages/RecentlyDeletedPage'),
);
export const loadNotifications = chunkLoader(() => import('@/components/pages/NotificationsPage'));
export const loadPostRefResolver = chunkLoader(() => import('@/components/refs/PostRefResolver'));
export const loadBriefRefResolver = chunkLoader(() => import('@/components/refs/BriefRefResolver'));

type ChunkLoad = () => Promise<unknown>;

/**
 * The chunks a signed-in path renders inside the shell (App.tsx's routes), or
 * [] for a path outside it. An unknown path redirects to /pipeline. Pure.
 */
export function routeChunkLoaders(pathname: string): readonly ChunkLoad[] {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  const [, first = '', second] = path.split('/');
  const detail = second !== undefined && second !== '';
  switch (first) {
    case '':
    case 'pipeline':
      return [loadPipeline];
    case 'posts':
      return detail ? [loadPostDetail] : [loadPipeline];
    case 'p':
      return detail ? [loadPostRefResolver] : [loadPipeline];
    case 'briefs':
      return detail ? [loadBriefDetail] : [loadBriefs];
    case 'b':
      return detail ? [loadBriefRefResolver] : [loadPipeline];
    case 'chat':
      return [loadChat];
    case 'notifications':
    case 'activity':
      return [loadPlanBeside, loadNotifications];
    case 'plans':
      return [loadPlanBeside, loadNotifications, loadPlan];
    case 'plan':
      return detail ? [loadPlanBeside, loadPlanTab, loadPlan] : [loadPlanBeside, loadPlanTab];
    case 'assets':
      return [loadAssets];
    case 'settings':
      return [loadSettings];
    case 'help':
      return [loadHelp];
    case 'deleted':
      return [loadRecentlyDeleted];
    case 'signin':
    case 'signup':
    case 'auth':
    case 'legal':
    case 'unsubscribe':
    case 'invite':
    case 'test':
    case 'demo':
      return [];
    default:
      return [loadPipeline];
  }
}

/**
 * Boot with a stored session (main.tsx): start the shell unit and the current
 * route's chunks now, in parallel with the app chunk and getSession, instead
 * of after the session resolves and the shell mounts. Code only: import() runs
 * no data fetch. A failure is swallowed (the route's own lazy load retries and
 * owns the reload guard).
 */
export function startBootChunks(pathname: string): void {
  const route = routeChunkLoaders(pathname);
  // Sign in, sign up, invite and the other outside pages never mount the shell first.
  if (route.length === 0) return;
  for (const load of [loadShell, ...route]) {
    try {
      void load().catch(() => undefined);
    } catch {
      // A loader that throws synchronously is the same harmless miss.
    }
  }
}

// The shell (AppLayout) asks chunk-reload.ts whether the first route's chunks
// have landed; this module hands it the route table, so AppLayout never links
// every page.
setRouteChunkTable(routeChunkLoaders);

type Loader = () => Promise<unknown>;

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
