import { afterEach, describe, expect, it, vi } from 'vitest';
import { TRACE_ID_HEADER } from '@/server/trace';
import { tracedFetch } from '@/server/traced-fetch';

// Regression: the asset Workers must not transitively evaluate the browser env
// validator (src/lib/env.ts) at import time. It validates import.meta.env at
// module scope and throws when the VITE_ vars are absent (the Worker case),
// which made `wrangler deploy` fail with error 10021. We prove the negative by
// blanking those vars, resetting the module registry, and asserting a fresh
// dynamic import of each Worker entrypoint resolves. Before the fix the import
// chain ran @/lib/fetch -> @/lib/logger -> @/lib/sentry -> @/lib/env and threw.

describe('worker entrypoints do not evaluate @/lib/env at import', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('imports asset-read without throwing when browser env is unset', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_SUPABASE_URL', '');
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', '');
    await expect(import('@/server/workers/asset-read')).resolves.toBeDefined();
  });

  it('imports asset-upload without throwing when browser env is unset', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_SUPABASE_URL', '');
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', '');
    await expect(import('@/server/workers/asset-upload')).resolves.toBeDefined();
  });
});

describe('tracedFetch', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sets TRACE_ID_HEADER on the outgoing request from the explicit trace id', async () => {
    let seen: Headers | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      seen = new Headers(init?.headers);
      return Promise.resolve(new Response(null, { status: 200 }));
    });

    await tracedFetch('https://r2.example/obj', { method: 'PUT' }, 'trace-abc-123');

    expect(seen?.get(TRACE_ID_HEADER)).toBe('trace-abc-123');
  });

  it('mints a trace id when none is supplied', async () => {
    let seen: Headers | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      seen = new Headers(init?.headers);
      return Promise.resolve(new Response(null, { status: 200 }));
    });

    await tracedFetch('https://r2.example/obj');

    expect(seen?.get(TRACE_ID_HEADER)).toBeTruthy();
  });

  it('preserves a trace id already present on init headers', async () => {
    let seen: Headers | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      seen = new Headers(init?.headers);
      return Promise.resolve(new Response(null, { status: 200 }));
    });

    await tracedFetch(
      'https://r2.example/obj',
      { headers: { [TRACE_ID_HEADER]: 'incoming-id' } },
      'overriding-id',
    );

    expect(seen?.get(TRACE_ID_HEADER)).toBe('incoming-id');
  });
});
