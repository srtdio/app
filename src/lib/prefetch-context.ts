// The press prefetch's shared state, kept in a module that links no page and
// no read module (so a lib module or a shell control that imports it never
// pulls them into its graph):
// - who a press reads for: set by the shell once the session and the active
//   workspace are known (AppLayout), read by the press starters;
// - the chunks a press starts beyond the primary nav (a post card, the bell,
//   the avatar) and each route's first reads (src/lib/route-data.ts): App.tsx
//   registers them when it loads, before the shell mounts.

import { logger } from '@/lib/logger';

/** Who is asking and in which workspace; null before the shell knows. */
export interface PrefetchContext {
  userId: string;
  workspaceId: string;
}

let context: PrefetchContext | null = null;

/** Set by the shell once the session and the active workspace are known. */
export function setPrefetchContext(next: PrefetchContext | null): void {
  context = next;
}

export function getPrefetchContext(): PrefetchContext | null {
  return context;
}

type ChunkLoad = () => Promise<unknown>;

let postOpenChunks: readonly ChunkLoad[] = [];

/** App.tsx: the chunks a post card press starts (the /p/:ref resolver, Post detail). */
export function setPostOpenChunks(loaders: readonly ChunkLoad[]): void {
  postOpenChunks = loaders;
}

export function getPostOpenChunks(): readonly ChunkLoad[] {
  return postOpenChunks;
}

/** The presses that start chunks outside the primary nav. */
export type PressChunks = 'activity' | 'settings';

const pressChunks: Record<PressChunks, readonly ChunkLoad[]> = { activity: [], settings: [] };

/** App.tsx: the chunks the bell press (Activity) and the avatar press (Settings) start. */
export function setPressChunks(press: PressChunks, loaders: readonly ChunkLoad[]): void {
  pressChunks[press] = loaders;
}

export function getPressChunks(press: PressChunks): readonly ChunkLoad[] {
  return pressChunks[press];
}

export type DataStarter = (ctx: PrefetchContext) => Promise<void>;

let routeDataStarters: Readonly<Record<string, DataStarter>> = {};

/** route-data.ts (loaded by App.tsx): each route's first reads. */
export function setRouteDataStarters(starters: Readonly<Record<string, DataStarter>>): void {
  routeDataStarters = starters;
}

/** Start a route's first reads (every press; sharedRead joins a fresh one). */
export function prefetchRouteData(
  path: string,
  starters: Readonly<Record<string, DataStarter>> = routeDataStarters,
): void {
  const ctx = getPrefetchContext();
  const start = starters[path];
  if (ctx === null || start === undefined) return;
  try {
    void start(ctx).catch((err: unknown) => {
      logger.warn('route data prefetch failed', { path, error: String(err) });
    });
  } catch (err: unknown) {
    logger.warn('route data prefetch failed', { path, error: String(err) });
  }
}
