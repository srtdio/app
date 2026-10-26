import { afterEach, describe, expect, it, vi } from 'vitest';
import { prefetchRouteData, setPrefetchContext } from '@/lib/route-data';

afterEach(() => setPrefetchContext(null));

describe('prefetchRouteData', () => {
  it('does nothing before the shell knows the user and workspace', () => {
    const start = vi.fn(() => Promise.resolve());
    prefetchRouteData('/assets', { '/assets': start });
    expect(start).not.toHaveBeenCalled();
  });

  it('starts the route reads with the current context', () => {
    const start = vi.fn(() => Promise.resolve());
    setPrefetchContext({ userId: 'u', workspaceId: 'w' });
    prefetchRouteData('/assets', { '/assets': start });
    expect(start).toHaveBeenCalledWith({ userId: 'u', workspaceId: 'w' });
  });

  it('swallows a failing starter', () => {
    setPrefetchContext({ userId: 'u', workspaceId: 'w' });
    expect(() =>
      prefetchRouteData('/x', {
        '/x': () => {
          throw new Error('boom');
        },
      }),
    ).not.toThrow();
  });
});
