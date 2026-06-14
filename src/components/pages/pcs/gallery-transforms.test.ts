import { describe, expect, it } from 'vitest';
import {
  append,
  insertAfter,
  moveLeft,
  moveRight,
  removeAt,
} from '@/components/pages/pcs/gallery-transforms';

const ids = ['a', 'b', 'c'];

describe('moveLeft', () => {
  it('swaps with the previous item', () => {
    expect(moveLeft(ids, 1)).toEqual(['b', 'a', 'c']);
    expect(moveLeft(ids, 2)).toEqual(['a', 'c', 'b']);
  });
  it('is a no-op at the first index or out of range', () => {
    expect(moveLeft(ids, 0)).toEqual(['a', 'b', 'c']);
    expect(moveLeft(ids, 9)).toEqual(['a', 'b', 'c']);
  });
  it('does not mutate the input', () => {
    const input = [...ids];
    moveLeft(input, 1);
    expect(input).toEqual(['a', 'b', 'c']);
  });
});

describe('moveRight', () => {
  it('swaps with the next item', () => {
    expect(moveRight(ids, 0)).toEqual(['b', 'a', 'c']);
    expect(moveRight(ids, 1)).toEqual(['a', 'c', 'b']);
  });
  it('is a no-op at the last index or out of range', () => {
    expect(moveRight(ids, 2)).toEqual(['a', 'b', 'c']);
    expect(moveRight(ids, -1)).toEqual(['a', 'b', 'c']);
  });
});

describe('append', () => {
  it('adds at the end', () => {
    expect(append(ids, 'd')).toEqual(['a', 'b', 'c', 'd']);
    expect(append([], 'd')).toEqual(['d']);
  });
});

describe('insertAfter', () => {
  it('inserts immediately after the index', () => {
    expect(insertAfter(ids, 0, 'x')).toEqual(['a', 'x', 'b', 'c']);
    expect(insertAfter(ids, 2, 'x')).toEqual(['a', 'b', 'c', 'x']);
  });
  it('clamps an out-of-range index into the list', () => {
    expect(insertAfter(ids, 9, 'x')).toEqual(['a', 'b', 'c', 'x']);
    expect(insertAfter(ids, -5, 'x')).toEqual(['x', 'a', 'b', 'c']);
  });
});

describe('removeAt', () => {
  it('removes the item at the index', () => {
    expect(removeAt(ids, 1)).toEqual(['a', 'c']);
  });
  it('is an out-of-range no-op copy', () => {
    expect(removeAt(ids, 9)).toEqual(['a', 'b', 'c']);
  });
  it('throws rather than ever producing an empty gallery', () => {
    expect(() => removeAt(['only'], 0)).toThrow();
  });
});
