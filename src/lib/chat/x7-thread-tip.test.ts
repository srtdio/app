// X7 design 2 (H6): the thread tip shows once per user. Every storage read
// and write is wrapped; when storage fails it shows once per page load.
import { afterEach, describe, expect, it } from 'vitest';
import {
  HOLD_TIP_DISMISS,
  HOLD_TIP_TEXT,
  HOLD_TIP_TEXT_LAPTOP,
  holdTipShowsKey,
  dismissHoldTip,
  holdTipKey,
  noteHoldTipShown,
  resetHoldTip,
  shouldShowHoldTip,
  type TipStorage,
} from '@/lib/chat/thread-tip';

function memory(): TipStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

const broken: TipStorage = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
};

afterEach(() => resetHoldTip());

describe('X7 H6: the one-time hold tip', () => {
  it('copy: the tip and its Got it', () => {
    expect(HOLD_TIP_TEXT).toBe('Tap a message to reply in thread.');
    expect(HOLD_TIP_TEXT_LAPTOP).toBe('Click a message to reply in thread.');
    expect(HOLD_TIP_DISMISS).toBe('Got it');
  });

  it('shows until Got it, then never again for that user (stored per user)', () => {
    const storage = memory();
    expect(shouldShowHoldTip('u1', storage)).toBe(true);
    noteHoldTipShown('u1', storage);
    expect(shouldShowHoldTip('u1', storage)).toBe(true);
    dismissHoldTip('u1', storage);
    expect(storage.data.get(holdTipKey('u1'))).toBe('1');
    expect(shouldShowHoldTip('u1', storage)).toBe(false);
    resetHoldTip();
    // A new page load still reads the stored flag.
    expect(shouldShowHoldTip('u1', storage)).toBe(false);
    expect(shouldShowHoldTip('u2', storage)).toBe(true);
  });

  it('storage that throws: shown once per page load, never a crash', () => {
    expect(shouldShowHoldTip('u1', broken)).toBe(true);
    noteHoldTipShown('u1', broken);
    expect(shouldShowHoldTip('u1', broken)).toBe(false);
    expect(() => dismissHoldTip('u1', broken)).not.toThrow();
    resetHoldTip();
    expect(shouldShowHoldTip('u1', broken)).toBe(true);
  });

  it('no storage at all behaves like failing storage', () => {
    expect(shouldShowHoldTip('u1', null)).toBe(true);
    noteHoldTipShown('u1', null);
    expect(shouldShowHoldTip('u1', null)).toBe(false);
  });

  it('no user, no tip', () => {
    expect(shouldShowHoldTip('', memory())).toBe(false);
  });

  it('goes for good after 3 chat opens', () => {
    const storage = memory();
    noteHoldTipShown('u1', storage);
    noteHoldTipShown('u1', storage);
    expect(shouldShowHoldTip('u1', storage)).toBe(true);
    noteHoldTipShown('u1', storage);
    expect(storage.data.get(holdTipShowsKey('u1'))).toBe('3');
    expect(shouldShowHoldTip('u1', storage)).toBe(false);
  });

  it('goes for good on the first thread open (openThread calls dismiss)', () => {
    const storage = memory();
    dismissHoldTip('u1', storage);
    resetHoldTip();
    expect(shouldShowHoldTip('u1', storage)).toBe(false);
  });
});
