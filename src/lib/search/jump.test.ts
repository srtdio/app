import { describe, expect, it } from 'vitest';
import {
  hasSearchJump,
  readSearchJump,
  withoutSearchJump,
  withSearchJump,
} from '@/lib/search/jump';

describe('withSearchJump (the one jump mechanism)', () => {
  it('adds the searched words to a path, keeping its own target param', () => {
    expect(withSearchJump('/p/gbl-7', 'Launch day')).toBe('/p/gbl-7?q=Launch+day');
    expect(withSearchJump('/p/gbl-3?comment=c1', 'hello')).toBe('/p/gbl-3?comment=c1&q=hello');
    expect(withSearchJump('/chat?channel=g&message=m1', ' see ')).toBe(
      '/chat?channel=g&message=m1&q=see',
    );
  });

  it('adds a generic target only when the destination has no param of its own', () => {
    expect(withSearchJump('/plans/pl1', 'reel', 'i1')).toBe('/plans/pl1?q=reel&at=i1');
  });

  it('leaves a path unchanged without a query or target', () => {
    expect(withSearchJump('/plans/pl1', '   ')).toBe('/plans/pl1');
    expect(withSearchJump('/plans/pl1', '', '')).toBe('/plans/pl1');
  });
});

describe('readSearchJump / withoutSearchJump', () => {
  it('reads the words (the search rule: lowercased, deduped) and the target', () => {
    const params = new URLSearchParams('channel=g&q=Diwali+diwali+Lights&at=i9');
    expect(readSearchJump(params)).toEqual({ words: ['diwali', 'lights'], targetId: 'i9' });
    expect(hasSearchJump(params)).toBe(true);
  });

  it('a url without a jump reads empty', () => {
    const params = new URLSearchParams('channel=g&message=m1');
    expect(readSearchJump(params)).toEqual({ words: [], targetId: null });
    expect(hasSearchJump(params)).toBe(false);
  });

  it('strips only the jump keys; the destination params stay', () => {
    const next = withoutSearchJump(new URLSearchParams('comment=c1&q=hello&at=x&tab=feedback'));
    expect(next.toString()).toBe('comment=c1&tab=feedback');
  });
});
