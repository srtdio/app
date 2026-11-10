import { beforeEach, describe, expect, it } from 'vitest';
import {
  THREAD_TIP_MAX_SHOWS,
  dismissThreadTip,
  noteThreadTipShown,
  resetThreadTip,
  threadTipVisible,
} from '@/lib/catch-up/tip';

function store() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

describe('catch-up thread tip', () => {
  beforeEach(() => resetThreadTip());

  it('shows until Got it, then never again for that user', () => {
    const s = store();
    expect(threadTipVisible('u1', s)).toBe(true);
    dismissThreadTip('u1', s);
    expect(threadTipVisible('u1', s)).toBe(false);
    resetThreadTip();
    expect(threadTipVisible('u1', s)).toBe(false);
    expect(threadTipVisible('u2', s)).toBe(true);
  });

  it('the first thread opened from a card dismisses it (same call as Got it)', () => {
    const s = store();
    noteThreadTipShown('u1', s);
    dismissThreadTip('u1', s);
    expect(threadTipVisible('u1', s)).toBe(false);
  });

  it('goes by itself after showing on 3 catch-up opens', () => {
    const s = store();
    for (let open = 1; open <= THREAD_TIP_MAX_SHOWS; open += 1) {
      expect(threadTipVisible('u1', s)).toBe(true);
      noteThreadTipShown('u1', s);
    }
    expect(threadTipVisible('u1', s)).toBe(false);
  });

  it('a failing storage shows it once per page load', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(threadTipVisible('u1', broken)).toBe(true);
    noteThreadTipShown('u1', broken);
    expect(threadTipVisible('u1', broken)).toBe(false);
    expect(threadTipVisible('', store())).toBe(false);
  });
});
