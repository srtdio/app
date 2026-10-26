// @vitest-environment jsdom
// Boot: with a stored session, main.tsx starts the shell unit and the current
// route's chunk at once (startBootChunks), in parallel with the app chunk and
// getSession, and a route whose chunk has landed renders with no Suspense
// fallback (lazyRoute over a chunkLoader).
import { Suspense, act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Each module the boot asks for is a stub that counts its evaluation.
const evaluated = vi.hoisted(() => ({ names: [] as string[] }));
vi.mock('@/lib/workspace-context', () => {
  evaluated.names.push('workspace-context');
  return {};
});
vi.mock('@/lib/chat', () => {
  evaluated.names.push('chat');
  return {};
});
vi.mock('@/components/shell/AppLayout', () => {
  evaluated.names.push('AppLayout');
  return {};
});
vi.mock('@/components/pages/PipelinePage', () => {
  evaluated.names.push('PipelinePage');
  return { PipelinePage: () => null };
});
vi.mock('@/components/pages/PostDetailPage', () => {
  evaluated.names.push('PostDetailPage');
  return { PostDetailPage: () => null };
});

import { hasStoredSession } from '@/components/home/guest-path';
import {
  chunkLoader,
  lazyRoute,
  loadBriefDetail,
  loadNotifications,
  loadPipeline,
  loadPlan,
  loadPlanBeside,
  loadPlanTab,
  loadPostDetail,
  loadShell,
  loadedChunk,
  routeChunkLoaders,
  routeChunksLoaded,
  startBootChunks,
} from '@/lib/chunk-reload';

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
}

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('hasStoredSession', () => {
  it('checks only that a supabase-js auth key exists', () => {
    expect(hasStoredSession(() => ['sb-abc-auth-token'])).toBe(true);
    expect(hasStoredSession(() => ['sorted-theme'])).toBe(false);
    expect(
      hasStoredSession(() => {
        throw new Error('blocked');
      }),
    ).toBe(false);
  });
});

describe('routeChunkLoaders', () => {
  it('maps each signed-in path to the chunks it renders', () => {
    expect(routeChunkLoaders('/pipeline')).toEqual([loadPipeline]);
    expect(routeChunkLoaders('/')).toEqual([loadPipeline]);
    expect(routeChunkLoaders('/posts/p1')).toEqual([loadPostDetail]);
    expect(routeChunkLoaders('/briefs/b1/')).toEqual([loadBriefDetail]);
    expect(routeChunkLoaders('/notifications')).toEqual([loadPlanBeside, loadNotifications]);
    expect(routeChunkLoaders('/plan')).toEqual([loadPlanBeside, loadPlanTab]);
    expect(routeChunkLoaders('/plan/x')).toEqual([loadPlanBeside, loadPlanTab, loadPlan]);
    expect(routeChunkLoaders('/nowhere')).toEqual([loadPipeline]);
  });

  it('starts nothing for pages outside the shell', () => {
    for (const path of ['/signin', '/signup', '/auth/callback', '/invite/accept/x', '/demo']) {
      expect(routeChunkLoaders(path)).toEqual([]);
    }
  });
});

describe('startBootChunks', () => {
  it('starts the shell unit and the route chunk together, before either lands', async () => {
    expect(loadedChunk(loadShell)).toBeUndefined();
    startBootChunks('/pipeline');
    // Both were asked for in the same tick: neither has landed yet.
    expect(loadedChunk(loadShell)).toBeUndefined();
    expect(loadedChunk(loadPipeline)).toBeUndefined();
    await flush();
    expect(evaluated.names).toEqual(
      expect.arrayContaining(['workspace-context', 'chat', 'AppLayout', 'PipelinePage']),
    );
    expect(loadedChunk(loadShell)).toBeDefined();
    expect(routeChunksLoaded('/pipeline')).toBe(true);
    // The route's own lazy load later reuses the same promise: no second import.
    const before = evaluated.names.length;
    await loadPipeline();
    expect(evaluated.names.length).toBe(before);
  });

  it('starts nothing on sign in', () => {
    const before = evaluated.names.length;
    startBootChunks('/signin');
    expect(evaluated.names.length).toBe(before);
  });
});

describe('chunkLoader', () => {
  it('imports once, records the module, and forgets a failure so the next call retries', async () => {
    let calls = 0;
    const load = chunkLoader(async () => {
      calls += 1;
      if (calls === 1) throw new Error('Failed to fetch dynamically imported module');
      return { ok: true };
    });
    await expect(load()).rejects.toThrow();
    expect(loadedChunk(load)).toBeUndefined();
    await expect(load()).resolves.toEqual({ ok: true });
    await load();
    expect(calls).toBe(2);
    expect(loadedChunk(load)).toEqual({ ok: true });
  });
});

describe('lazyRoute over a landed chunk', () => {
  it('renders the page directly: the Suspense fallback never shows', async () => {
    function Page(): ReactElement {
      return createElement('p', null, 'page');
    }
    const load = chunkLoader(async () => ({ Page }));
    await load();
    const Route = lazyRoute(load, (m) => m.Page);
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const fallbacks: string[] = [];
    function Fallback(): ReactElement {
      fallbacks.push('fallback');
      return createElement('p', null, 'Loading');
    }
    act(() => {
      root!.render(
        createElement(Suspense, { fallback: createElement(Fallback) }, createElement(Route)),
      );
    });
    expect(host.textContent).toBe('page');
    expect(fallbacks).toEqual([]);
  });

  it('a chunk not yet landed suspends as before, then renders', async () => {
    function Page(): ReactElement {
      return createElement('p', null, 'later');
    }
    const load = chunkLoader(async () => ({ Page }));
    const Route = lazyRoute(load, (m) => m.Page);
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root!.render(
        createElement(
          Suspense,
          { fallback: createElement('p', null, 'Loading') },
          createElement(Route),
        ),
      );
    });
    await flush();
    expect(host.textContent).toBe('later');
  });
});
