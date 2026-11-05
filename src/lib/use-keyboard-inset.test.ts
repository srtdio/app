import { describe, expect, it } from 'vitest';
import { keyboardInset } from '@/lib/use-keyboard-inset';

describe('keyboardInset', () => {
  it('is 0 with no visualViewport', () => {
    expect(keyboardInset(800, null)).toBe(0);
    expect(keyboardInset(800, undefined)).toBe(0);
  });

  it('innerHeight - vv.height - vv.offsetTop', () => {
    expect(keyboardInset(844, { height: 508, offsetTop: 0 })).toBe(336);
    expect(keyboardInset(844, { height: 508, offsetTop: 20 })).toBe(316);
  });

  it('ignores small browser-bar jitter', () => {
    expect(keyboardInset(844, { height: 820, offsetTop: 0 })).toBe(0);
  });

  it('never negative', () => {
    expect(keyboardInset(800, { height: 900, offsetTop: 0 })).toBe(0);
  });
});
