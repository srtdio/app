import { describe, expect, it } from 'vitest';
import { diffSegments, tokenize } from '@/lib/text-diff';
import type { DiffSegment } from '@/lib/text-diff';

// Reconstruct the earlier caption (eq + del) and later caption (eq + add) from a
// segment list; both must round-trip so the segments never drop or invent text.
function reconstructA(segs: DiffSegment[]): string {
  return segs
    .filter((s) => s.kind !== 'add')
    .map((s) => s.text)
    .join('');
}
function reconstructB(segs: DiffSegment[]): string {
  return segs
    .filter((s) => s.kind !== 'del')
    .map((s) => s.text)
    .join('');
}

describe('tokenize', () => {
  it('keeps whitespace tokens and drops empty boundary tokens', () => {
    expect(tokenize('a b')).toEqual(['a', ' ', 'b']);
    expect(tokenize(' a')).toEqual([' ', 'a']);
    expect(tokenize('')).toEqual([]);
  });
});

describe('diffSegments', () => {
  it('identical texts: all eq, zero counts, 0%', () => {
    const r = diffSegments('hello world', 'hello world');
    expect(r.segs).not.toBeNull();
    expect(r.segs?.every((s) => s.kind === 'eq')).toBe(true);
    expect(r.addedWords).toBe(0);
    expect(r.removedWords).toBe(0);
    expect(r.changedPct).toBe(0);
  });

  it('empty vs text: everything added, 100%', () => {
    const r = diffSegments('', 'hello world');
    expect(r.addedWords).toBe(2);
    expect(r.removedWords).toBe(0);
    expect(r.changedPct).toBe(100);
    expect(r.segs).not.toBeNull();
    expect(reconstructA(r.segs ?? [])).toBe('');
    expect(reconstructB(r.segs ?? [])).toBe('hello world');
  });

  it('one word added', () => {
    const r = diffSegments('hello world', 'hello brave world');
    expect(r.addedWords).toBe(1);
    expect(r.removedWords).toBe(0);
    expect(r.changedPct).toBe(20);
    expect(reconstructA(r.segs ?? [])).toBe('hello world');
    expect(reconstructB(r.segs ?? [])).toBe('hello brave world');
  });

  it('one word removed', () => {
    const r = diffSegments('hello brave world', 'hello world');
    expect(r.addedWords).toBe(0);
    expect(r.removedWords).toBe(1);
    expect(r.changedPct).toBe(20);
    expect(reconstructA(r.segs ?? [])).toBe('hello brave world');
    expect(reconstructB(r.segs ?? [])).toBe('hello world');
  });

  it('whitespace-only change: no words added or removed, 0%', () => {
    const r = diffSegments('a b', 'a  b');
    expect(r.addedWords).toBe(0);
    expect(r.removedWords).toBe(0);
    expect(r.changedPct).toBe(0);
    expect(reconstructA(r.segs ?? [])).toBe('a b');
    expect(reconstructB(r.segs ?? [])).toBe('a  b');
  });

  it('full rewrite: no shared words, 100%', () => {
    const r = diffSegments('alpha beta', 'gamma delta');
    expect(r.addedWords).toBe(2);
    expect(r.removedWords).toBe(2);
    expect(r.changedPct).toBe(100);
    expect(reconstructA(r.segs ?? [])).toBe('alpha beta');
    expect(reconstructB(r.segs ?? [])).toBe('gamma delta');
  });

  it('both empty: 0% and no counts', () => {
    const r = diffSegments('', '');
    expect(r.addedWords).toBe(0);
    expect(r.removedWords).toBe(0);
    expect(r.changedPct).toBe(0);
  });

  it('guard path: oversized inputs return segs=null with whole-text counts', () => {
    // 2001 tokens each aligns to > 2M cells: segs must be null and the counts
    // fall back to the whole-text word counts (every word replaced).
    const wordsA = 1500;
    const wordsB = 1500;
    const a = Array.from({ length: wordsA }, (_, i) => `a${i}`).join(' ');
    const b = Array.from({ length: wordsB }, (_, i) => `b${i}`).join(' ');
    const r = diffSegments(a, b);
    expect(r.segs).toBeNull();
    expect(r.addedWords).toBe(wordsB);
    expect(r.removedWords).toBe(wordsA);
    expect(r.changedPct).toBe(100);
  });
});
