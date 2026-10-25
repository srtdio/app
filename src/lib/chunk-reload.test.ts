import { describe, expect, it, vi } from 'vitest';
import {
  CHUNK_RELOAD_KEY,
  chunkUrlFromError,
  isChunkLoadError,
  reloadIfStale,
  reloadOnce,
  withChunkReload,
  type ChunkReloadDeps,
} from '@/lib/chunk-reload';

const BASE = 'https://app.example.test/pipeline';

/** Deps with an in-memory guard; the HEAD probe answers `status` (404: a stale build). */
function memoryDeps(status: number | null = 404) {
  const map = new Map<string, string>();
  const reload = vi.fn();
  const probe = vi.fn<(url: string) => Promise<number | null>>(() => Promise.resolve(status));
  const deps: ChunkReloadDeps = {
    storage: () => ({
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => {
        map.set(key, value);
      },
    }),
    reload,
    probe,
    baseUrl: () => BASE,
  };
  return { ...deps, reload, probe };
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

  it('two failures from two different call sites still produce at most one reload', async () => {
    // One shared guard: a route chunk, the agora SDK load and a boot import all
    // go through reloadOnce(), so a second failing site never reloads again.
    const deps = memoryDeps();
    const routeChunk = withChunkReload(() => Promise.reject(chunkError()), deps);
    const sdkChunk = withChunkReload(() => Promise.reject(chunkError()), deps);

    void routeChunk();
    await new Promise((r) => setTimeout(r, 0));
    await expect(sdkChunk()).rejects.toBeInstanceOf(TypeError);
    // A boot import failure (main.tsx calls reloadOnce directly) is refused too.
    expect(reloadOnce(deps)).toBe(false);
    expect(deps.reload).toHaveBeenCalledTimes(1);
  });

  it('never reloads while the page is being left (aborted imports are not stale chunks)', async () => {
    const deps = { ...memoryDeps(), isLeaving: () => true };
    const load = withChunkReload(() => Promise.reject(chunkError()), deps);

    let settled = false;
    void load().then(
      () => (settled = true),
      () => (settled = true),
    );
    await new Promise((r) => setTimeout(r, 0));
    // No reload, no error surfaced: the page is going away anyway.
    expect(settled).toBe(false);
    expect(reloadOnce(deps)).toBe(false);
    expect(deps.reload).not.toHaveBeenCalled();
    // The guard is untouched, so a real stale chunk later still gets its reload.
    expect(deps.storage().getItem(CHUNK_RELOAD_KEY)).toBeNull();
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

describe('proven stale chunk check', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('a TypeError without a module URL never reloads and is rethrown', async () => {
    const deps = memoryDeps(404);
    // WebKit's message names no URL; an aborted fetch is a bare TypeError.
    for (const err of [
      new TypeError('Importing a module script failed.'),
      new TypeError('Load failed'),
    ]) {
      const load = withChunkReload(() => Promise.reject(err), deps);
      await expect(load()).rejects.toBe(err);
    }
    expect(deps.probe).not.toHaveBeenCalled();
    expect(deps.reload).not.toHaveBeenCalled();
    expect(deps.storage().getItem(CHUNK_RELOAD_KEY)).toBeNull();
  });

  it('a plain TypeError is not a chunk load error', () => {
    expect(isChunkLoadError(new TypeError('Load failed'))).toBe(false);
    expect(isChunkLoadError(new TypeError('x is not a function'))).toBe(false);
    expect(isChunkLoadError(chunkError())).toBe(true);
    expect(
      isChunkLoadError(new TypeError('error loading dynamically imported module: /assets/a.js')),
    ).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
  });

  it('reads the module URL from Chromium, Firefox and Vite messages, same origin only', () => {
    expect(chunkUrlFromError(chunkError(), BASE)).toBe(
      'https://app.example.test/assets/Page-abc.js',
    );
    expect(
      chunkUrlFromError(
        new TypeError(
          'error loading dynamically imported module: https://app.example.test/assets/b.js',
        ),
        BASE,
      ),
    ).toBe('https://app.example.test/assets/b.js');
    expect(chunkUrlFromError(new Error('Unable to preload CSS for /assets/x.css'), BASE)).toBe(
      'https://app.example.test/assets/x.css',
    );
    expect(chunkUrlFromError(new TypeError('Importing a module script failed.'), BASE)).toBeNull();
    expect(
      chunkUrlFromError(
        new TypeError('Failed to fetch dynamically imported module: https://cdn.other.test/a.js'),
        BASE,
      ),
    ).toBeNull();
  });

  it('HEAD 200 for the module URL: no reload, the error is rethrown', async () => {
    const deps = memoryDeps(200);
    const err = chunkError();
    const load = withChunkReload(() => Promise.reject(err), deps);
    await expect(load()).rejects.toBe(err);
    expect(deps.probe).toHaveBeenCalledWith('https://app.example.test/assets/Page-abc.js');
    expect(deps.reload).not.toHaveBeenCalled();
  });

  it('HEAD 404 reloads once; a second 404 does not reload again', async () => {
    const deps = memoryDeps(404);
    expect(await reloadIfStale(chunkError(), deps)).toBe(true);
    expect(await reloadIfStale(chunkError(), deps)).toBe(false);
    expect(deps.probe).toHaveBeenCalledTimes(2);
    expect(deps.reload).toHaveBeenCalledTimes(1);
  });

  it('HEAD 410 counts as stale', async () => {
    const deps = memoryDeps(410);
    expect(await reloadIfStale(chunkError(), deps)).toBe(true);
    expect(deps.reload).toHaveBeenCalledTimes(1);
  });

  it('leaving during the check: no reload, the guard is untouched', async () => {
    let leaving = false;
    const base = memoryDeps(404);
    const deps: ChunkReloadDeps = {
      ...base,
      isLeaving: () => leaving,
      probe: (url) => {
        // pagehide (or beforeunload, or a hidden page) lands while HEAD is in flight.
        leaving = true;
        return base.probe(url);
      },
    };
    const err = chunkError();
    const load = withChunkReload(() => Promise.reject(err), deps);
    await expect(load()).rejects.toBe(err);
    expect(base.reload).not.toHaveBeenCalled();
    expect(base.storage().getItem(CHUNK_RELOAD_KEY)).toBeNull();
  });

  it('a HEAD network error or timeout (null) never reloads', async () => {
    const deps = memoryDeps(null);
    const err = chunkError();
    const load = withChunkReload(() => Promise.reject(err), deps);
    await expect(load()).rejects.toBe(err);
    expect(deps.reload).not.toHaveBeenCalled();
  });

  it('a probe that throws never reloads', async () => {
    const deps: ChunkReloadDeps = {
      ...memoryDeps(),
      probe: () => Promise.reject(new TypeError('Load failed')),
    };
    expect(await reloadIfStale(chunkError(), deps)).toBe(false);
  });

  it('a proven stale chunk keeps the fallback up after the reload', async () => {
    const deps = memoryDeps(404);
    const load = withChunkReload(() => Promise.reject(chunkError()), deps);
    let settled = false;
    void load().then(
      () => (settled = true),
      () => (settled = true),
    );
    await flush();
    expect(settled).toBe(false);
    expect(deps.reload).toHaveBeenCalledTimes(1);
  });
});
