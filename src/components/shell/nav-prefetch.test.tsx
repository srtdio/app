// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { loaders, warn, routeData } = vi.hoisted(() => ({
  loaders: {
    pipeline: vi.fn(async () => ({})),
    settings: vi.fn(async () => ({})),
    plan: vi.fn(async () => ({})),
    notifications: vi.fn(async () => ({})),
  },
  warn: vi.fn(),
  routeData: vi.fn(),
}));

// The Pipeline loader is the one App.tsx's lazy route uses (chunk-reload); a
// spy stands in so the press is observable without loading the page.
vi.mock('@/lib/chunk-reload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chunk-reload')>()),
  loadPipeline: loaders.pipeline,
  loadSettings: loaders.settings,
  loadPlanBeside: loaders.plan,
  loadNotifications: loaders.notifications,
}));
// The data half of a press: observed, not run (its starters read Supabase).
vi.mock('@/lib/route-data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/route-data')>()),
  prefetchRouteData: routeData,
}));
vi.mock('@/lib/logger', () => ({
  logger: { warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/components/chat/ChatStoreProvider', () => ({
  useChatStore: () => ({ state: {} }),
}));
vi.mock('@/lib/chat/chat-store', () => ({ selectTotalUnread: () => 0 }));

import { BottomTabs } from '@/components/shell/BottomTabs';
import { Sidebar } from '@/components/shell/Sidebar';
import {
  IDLE_PREFETCH_LOADERS,
  NAV_ROUTE_LOADERS,
  activityPrefetchProps,
  loadBriefDetail,
  loadBriefRefResolver,
  loadHelp,
  loadPostDetail,
  loadPostRefResolver,
  loadRecentlyDeleted,
  prefetchRoute,
  resetRoutePrefetch,
  settingsPrefetchProps,
} from '@/lib/route-prefetch';
import { PRIMARY_NAV } from '@/components/shell/nav';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(node: ReactNode): HTMLDivElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(<MemoryRouter initialEntries={['/briefs']}>{node}</MemoryRouter>);
  });
  return host;
}

function link(container: HTMLElement, path: string): HTMLAnchorElement {
  const found = container.querySelector<HTMLAnchorElement>(`a[href="${path}"]`);
  if (found === null) throw new Error(`no nav link for ${path}`);
  return found;
}

function press(el: Element, type: 'pointerdown' | 'touchstart'): void {
  act(() => {
    el.dispatchEvent(new Event(type, { bubbles: true }));
  });
}

beforeEach(() => {
  resetRoutePrefetch();
  for (const load of Object.values(loaders)) load.mockClear();
  routeData.mockClear();
  warn.mockClear();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe('nav route loaders', () => {
  it('every primary nav item has a loader', () => {
    for (const item of PRIMARY_NAV) expect(NAV_ROUTE_LOADERS[item.to]).toBeDefined();
  });
});

describe('prefetchRoute', () => {
  it('loads a route once per session', () => {
    const load = vi.fn(async () => ({}));
    const map = { '/x': [load] };
    expect(prefetchRoute('/x', map)).toBe(true);
    expect(prefetchRoute('/x', map)).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('ignores a path with no loader', () => {
    expect(prefetchRoute('/nowhere', {})).toBe(false);
  });

  it('swallows a failed load with a warning', async () => {
    const load = vi.fn(async () => {
      throw new TypeError('Failed to fetch dynamically imported module');
    });
    prefetchRoute('/x', { '/x': [load] });
    await act(async () => {
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    });
    // Logged, not rethrown: no chunk-reload guard runs for a prefetch.
    expect(warn).toHaveBeenCalledWith(
      'route prefetch failed',
      expect.objectContaining({ path: '/x' }),
    );
  });

  it('swallows a loader that throws synchronously', () => {
    const load = vi.fn((): Promise<unknown> => {
      throw new Error('boom');
    });
    expect(() => prefetchRoute('/x', { '/x': [load] })).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });
});

describe('nav press prefetch', () => {
  it("Sidebar: pointerdown on a nav item calls that route's loader once", () => {
    const container = render(<Sidebar workspaceName="Kite - Instagram" clientName="Kite" />);
    const pipeline = link(container, '/pipeline');
    press(pipeline, 'pointerdown');
    press(pipeline, 'pointerdown');
    press(pipeline, 'touchstart');
    expect(loaders.pipeline).toHaveBeenCalledTimes(1);
  });

  it("BottomTabs: touchstart on a nav item calls that route's loader once", () => {
    const container = render(<BottomTabs />);
    const pipeline = link(container, '/pipeline');
    press(pipeline, 'touchstart');
    press(pipeline, 'pointerdown');
    expect(loaders.pipeline).toHaveBeenCalledTimes(1);
  });
});

describe('idle prefetch of every remaining route chunk', () => {
  it('lists every page the shell opens, each through its named loader', () => {
    for (const load of [
      loaders.settings,
      loaders.plan,
      loaders.notifications,
      loaders.pipeline,
      loadHelp,
      loadRecentlyDeleted,
      loadBriefDetail,
      loadPostDetail,
      loadPostRefResolver,
      loadBriefRefResolver,
    ]) {
      expect(IDLE_PREFETCH_LOADERS).toContain(load);
    }
  });
});

describe('bell and avatar press prefetch', () => {
  it('the bell press loads the Activity chunk and starts its first reads', () => {
    const props = activityPrefetchProps();
    act(() => props.onPointerDown());
    expect(loaders.notifications).toHaveBeenCalledTimes(1);
    expect(loaders.plan).toHaveBeenCalledTimes(1);
    expect(routeData).toHaveBeenCalledWith('/notifications');
  });

  it('the avatar press loads the Settings chunk and starts the members read', () => {
    const props = settingsPrefetchProps();
    act(() => props.onTouchStart());
    expect(loaders.settings).toHaveBeenCalledTimes(1);
    expect(routeData).toHaveBeenCalledWith('/settings');
  });
});
