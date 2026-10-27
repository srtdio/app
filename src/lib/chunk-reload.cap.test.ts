import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHUNK_WAIT_MS,
  reloadForChunkWait,
  setRouteChunkTable,
  whenRouteChunksSettle,
  type ChunkReloadDeps,
} from '@/lib/chunk-reload';

function memoryDeps(): ChunkReloadDeps & { reload: ReturnType<typeof vi.fn> } {
  const map = new Map<string, string>();
  const reload = vi.fn();
  return {
    storage: () => ({
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => {
        map.set(key, value);
      },
    }),
    reload,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  setRouteChunkTable(() => []);
  vi.useRealTimers();
});

describe('whenRouteChunksSettle ceiling', () => {
  it('settles at CHUNK_WAIT_MS when a chunk never lands', async () => {
    expect(CHUNK_WAIT_MS).toBe(10_000);
    setRouteChunkTable(() => [() => new Promise(() => undefined)]);
    let settled = false;
    void whenRouteChunksSettle('/pipeline').then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(CHUNK_WAIT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
  });

  it('settles as soon as the chunks land, and clears its timer', async () => {
    setRouteChunkTable(() => [() => Promise.resolve({})]);
    await whenRouteChunksSettle('/pipeline');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a failed chunk settles too (the route handles the error)', async () => {
    setRouteChunkTable(() => [() => Promise.reject(new Error('chunk'))]);
    await expect(whenRouteChunksSettle('/pipeline')).resolves.toBeUndefined();
  });
});

describe('reloadForChunkWait', () => {
  it('reloads once through the guard, and a later tap still reloads', () => {
    const deps = memoryDeps();
    reloadForChunkWait(deps);
    expect(deps.reload).toHaveBeenCalledTimes(1);
    reloadForChunkWait(deps);
    expect(deps.reload).toHaveBeenCalledTimes(2);
  });
});
