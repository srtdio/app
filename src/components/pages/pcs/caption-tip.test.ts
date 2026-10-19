import { describe, expect, it } from 'vitest';
import {
  CAPTION_TIP_TEXT,
  captionTipDismissed,
  captionTipKey,
  dismissCaptionTip,
  type TipStorage,
} from '@/components/pages/pcs/caption-tip';

function memoryStorage(): TipStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

const throwing: TipStorage = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
};

describe('caption tip', () => {
  it('has the approved copy and a per-user key', () => {
    expect(CAPTION_TIP_TEXT).toBe('Tip: select caption text to comment on it.');
    expect(captionTipKey('u1')).not.toBe(captionTipKey('u2'));
    expect(captionTipKey(null)).toContain('anon');
  });

  it('shows until Got it, then stays dismissed for that user only', () => {
    const storage = memoryStorage();
    expect(captionTipDismissed('u1', storage)).toBe(false);
    dismissCaptionTip('u1', storage);
    expect(captionTipDismissed('u1', storage)).toBe(true);
    expect(captionTipDismissed('u2', storage)).toBe(false);
  });

  it('a storage that throws never throws here: the tip reads as not dismissed', () => {
    expect(() => dismissCaptionTip('u1', throwing)).not.toThrow();
    expect(captionTipDismissed('u1', throwing)).toBe(false);
    expect(captionTipDismissed('u1', null)).toBe(false);
  });
});
