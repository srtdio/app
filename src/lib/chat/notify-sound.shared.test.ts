import { describe, expect, it } from 'vitest';
import {
  TONE_THROTTLE_MS,
  playToneShared,
  resetSharedTone,
  type ToneContext,
} from '@/lib/chat/notify-sound';

function fakeContext(): { ctx: ToneContext; starts: () => number } {
  let started = 0;
  const param = {
    setValueAtTime: () => undefined,
    linearRampToValueAtTime: () => undefined,
    exponentialRampToValueAtTime: () => undefined,
  };
  const ctx: ToneContext = {
    currentTime: 0,
    destination: {},
    createOscillator: () => ({
      type: 'sine',
      frequency: { setValueAtTime: () => undefined },
      connect: () => undefined,
      start: () => {
        started += 1;
      },
      stop: () => undefined,
    }),
    createGain: () => ({ gain: param, connect: () => undefined }),
  };
  return { ctx, starts: () => started };
}

describe('playToneShared (one throttle for chat and Activity)', () => {
  it('plays once inside the throttle window, again after it', () => {
    resetSharedTone();
    const { ctx } = fakeContext();
    expect(playToneShared(1_000, ctx)).toBe(true);
    expect(playToneShared(1_000 + TONE_THROTTLE_MS - 1, ctx)).toBe(false);
    expect(playToneShared(1_000 + TONE_THROTTLE_MS, ctx)).toBe(true);
  });

  it('does not consume the window when audio is unavailable', () => {
    resetSharedTone();
    expect(playToneShared(5_000, null)).toBe(false);
    const { ctx, starts } = fakeContext();
    expect(playToneShared(5_001, ctx)).toBe(true);
    expect(starts()).toBe(2);
  });
});
