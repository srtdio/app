import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// uuid_v7 pattern: time-ordered v7 (version nibble 7, variant 8/9/a/b).
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('trace module evaluation', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('performs no random generation at module evaluation', async () => {
    const randomSpy = vi.spyOn(globalThis.crypto, 'getRandomValues');
    await import('@/lib/trace');
    expect(randomSpy).not.toHaveBeenCalled();
  });

  it('lazily seeds a stable uuid_v7 on first getCurrentTraceId access', async () => {
    const { getCurrentTraceId } = await import('@/lib/trace');
    const first = getCurrentTraceId();
    expect(first).toMatch(UUID_V7);
    // Holder is stable across calls within the same logical context.
    expect(getCurrentTraceId()).toBe(first);
  });

  it('setCurrentTraceId overrides the lazy holder', async () => {
    const { getCurrentTraceId, setCurrentTraceId } = await import('@/lib/trace');
    setCurrentTraceId('11111111-1111-7111-8111-111111111111');
    expect(getCurrentTraceId()).toBe('11111111-1111-7111-8111-111111111111');
  });
});
