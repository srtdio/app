import { describe, expect, it, vi } from 'vitest';
import { warmMonoFont } from '@/lib/fonts';

describe('warmMonoFont', () => {
  it('asks for both JetBrains Mono weights chat uses', () => {
    const load = vi.fn(() => Promise.resolve([]));
    warmMonoFont({ load } as unknown as FontFaceSet);
    expect(load).toHaveBeenCalledTimes(2);
    expect(load.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      '400 1em "JetBrains Mono"',
      '500 1em "JetBrains Mono"',
    ]);
  });

  it('does nothing without a font set, and swallows a failed load', async () => {
    expect(() => warmMonoFont(undefined)).not.toThrow();
    const load = vi.fn(() => Promise.reject(new Error('offline')));
    expect(() => warmMonoFont({ load } as unknown as FontFaceSet)).not.toThrow();
    await Promise.resolve();
  });
});
