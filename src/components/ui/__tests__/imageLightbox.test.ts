import { describe, expect, it } from 'vitest';
import {
  createScrollLock,
  dominantAxisSwipe,
  lightboxCounter,
  wrapIndex,
  type LockableBody,
} from '@/components/ui/ImageLightbox';

// Pure, DOM-free coverage for the shared viewer's navigation math, its swipe
// gate, and its ref-counted body scroll lock (exercised through an injected
// fake body so no DOM is needed under the node test environment).

describe('wrapIndex', () => {
  it('loops from the last index forward to the first', () => {
    expect(wrapIndex(2, 1, 3)).toBe(0);
  });

  it('loops from the first index backward to the last', () => {
    expect(wrapIndex(0, -1, 3)).toBe(2);
  });

  it('steps within range without wrapping', () => {
    expect(wrapIndex(0, 1, 3)).toBe(1);
    expect(wrapIndex(2, -1, 3)).toBe(1);
  });

  it('always returns 0 for a single image, either direction', () => {
    expect(wrapIndex(0, 1, 1)).toBe(0);
    expect(wrapIndex(0, -1, 1)).toBe(0);
  });

  it('returns 0 for zero images', () => {
    expect(wrapIndex(0, 1, 0)).toBe(0);
    expect(wrapIndex(0, -1, 0)).toBe(0);
  });
});

describe('lightboxCounter', () => {
  it('formats a 1-based n / N counter', () => {
    expect(lightboxCounter(0, 3)).toBe('1 / 3');
    expect(lightboxCounter(2, 3)).toBe('3 / 3');
  });
});

describe('dominantAxisSwipe', () => {
  it('accepts a long, dominantly-horizontal swipe', () => {
    expect(dominantAxisSwipe(80, 10)).toBe(true);
  });

  it('rejects a swipe that is not dominantly horizontal', () => {
    expect(dominantAxisSwipe(80, 70)).toBe(false);
  });

  it('rejects a swipe below the horizontal threshold', () => {
    expect(dominantAxisSwipe(30, 0)).toBe(false);
  });
});

describe('createScrollLock', () => {
  function fakeBody(): LockableBody {
    return {
      style: { overflow: 'visible', touchAction: 'auto', paddingRight: '3px' },
      clientWidth: 980,
    };
  }

  it('acquires on first lock and restores the exact prior styles on release', () => {
    const body = fakeBody();
    const lock = createScrollLock(
      () => body,
      () => 1000,
    );

    lock.acquire();
    expect(body.style.overflow).toBe('hidden');
    expect(body.style.touchAction).toBe('none');
    // Scrollbar gutter (1000 - 980) is compensated as padding-right.
    expect(body.style.paddingRight).toBe('20px');

    lock.release();
    expect(body.style.overflow).toBe('visible');
    expect(body.style.touchAction).toBe('auto');
    expect(body.style.paddingRight).toBe('3px');
  });

  it('does not release early while a nested acquire is still open', () => {
    const body = fakeBody();
    const lock = createScrollLock(
      () => body,
      () => 1000,
    );

    lock.acquire();
    lock.acquire();

    // Inner release: still locked.
    lock.release();
    expect(body.style.overflow).toBe('hidden');
    expect(body.style.touchAction).toBe('none');

    // Outer release: fully restored.
    lock.release();
    expect(body.style.overflow).toBe('visible');
    expect(body.style.touchAction).toBe('auto');
    expect(body.style.paddingRight).toBe('3px');
  });
});
