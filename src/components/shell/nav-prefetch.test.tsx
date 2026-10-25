// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { loaders, warn } = vi.hoisted(() => ({
  loaders: { pipeline: vi.fn(async () => ({})) },
  warn: vi.fn(),
}));

// The Pipeline loader is the one App.tsx's lazy route uses (chunk-reload); a
// spy stands in so the press is observable without loading the page.
vi.mock('@/lib/chunk-reload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chunk-reload')>()),
  loadPipeline: loaders.pipeline,
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
import { NAV_ROUTE_LOADERS, prefetchRoute, resetRoutePrefetch } from '@/lib/route-prefetch';
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
  loaders.pipeline.mockClear();
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
