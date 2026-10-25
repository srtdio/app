import { describe, expect, it, vi } from 'vitest';
import {
  CHUNK_RELOAD_KEY,
  isChunkLoadError,
  reloadOnce,
  withChunkReload,
  type ChunkReloadDeps,
} from '@/lib/chunk-reload';

function memoryDeps() {
  const map = new Map<string, string>();
  const reload = vi.fn();
  const deps: ChunkReloadDeps = {
    storage: () => ({
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => {
        map.set(key, value);
      },
    }),
    reload,
  };
  return { ...deps, reload };
}

const chunkError = (): TypeError =>
  new TypeError('Failed to fetch dynamically imported module: /assets/Page-abc.js');

describe('chunk reload guard', () => {
  it('reloads once, never twice, across repeated chunk load failures', async () => {
    const deps = memoryDeps();
    const load = withChunkReload(() => Promise.reject(chunkError()), deps);

    // First failure: reload issued, the promise stays pending (fallback stays up).
    let settled = false;
    void load().then(
      () => (settled = true),
      () => (settled = true),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false);
    expect(deps.reload).toHaveBeenCalledTimes(1);
    expect(deps.storage().getItem(CHUNK_RELOAD_KEY)).toBe('1');

    // After the reload the same session fails again: the error surfaces, no reload.
    await expect(load()).rejects.toBeInstanceOf(TypeError);
    await expect(load()).rejects.toBeInstanceOf(TypeError);
    expect(deps.reload).toHaveBeenCalledTimes(1);
  });

  it('never reloads when storage throws', () => {
    const reload = vi.fn();
    const issued = reloadOnce({
      storage: () => {
        throw new Error('SecurityError');
      },
      reload,
    });
    expect(issued).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('rethrows non-chunk errors without reloading', async () => {
    const deps = memoryDeps();
    const load = withChunkReload(() => Promise.reject(new Error('boom')), deps);
    await expect(load()).rejects.toThrow('boom');
    expect(deps.reload).not.toHaveBeenCalled();
  });

  it('passes a successful load through', async () => {
    const deps = memoryDeps();
    const load = withChunkReload(() => Promise.resolve(42), deps);
    await expect(load()).resolves.toBe(42);
    expect(deps.reload).not.toHaveBeenCalled();
  });

  it('recognises CSS preload failures as chunk errors', () => {
    expect(isChunkLoadError(new Error('Unable to preload CSS for /assets/x.css'))).toBe(true);
    expect(isChunkLoadError(new Error('other'))).toBe(false);
  });
});
