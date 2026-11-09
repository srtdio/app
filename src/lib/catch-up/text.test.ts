import { describe, expect, it } from 'vitest';
import {
  clockLength,
  dayBreaks,
  fillScrollTop,
  foldNewlines,
  linkRuns,
  overClampLines,
  shortLink,
} from '@/lib/catch-up/text';

describe('catch-up text hygiene', () => {
  it('folds 3+ newlines to one blank line and trims', () => {
    expect(foldNewlines('\n\nHi\n\n\n\n\n\n\n\n\n\nthere  \n\n')).toBe('Hi\n\nthere');
    expect(foldNewlines('a\n\nb')).toBe('a\n\nb');
    expect(foldNewlines('a \r\n \r\n\r\n\r\nb')).toBe('a\n\nb');
  });

  it('shortens links: host without www, /…/, last part (18 + …)', () => {
    expect(shortLink('https://www.example.com/a/b/launch-plan')).toBe('example.com/…/launch-plan');
    expect(shortLink('https://example.com/one')).toBe('example.com/one');
    expect(shortLink('https://example.com/')).toBe('example.com');
    expect(shortLink(`https://example.com/x/${'a'.repeat(40)}`)).toBe(`example.com/…/${'a'.repeat(18)}…`);
  });

  it('finds links in text (a 120-character unbroken link included)', () => {
    const long = `https://example.com/${'z'.repeat(100)}`;
    const runs = linkRuns(`see ${long}, ok`);
    expect(runs.map((r) => r.kind)).toEqual(['text', 'link', 'text']);
    expect(runs[1]).toMatchObject({ kind: 'link', href: long });
    expect(runs[2]).toEqual({ kind: 'text', text: ', ok' });
  });

  it('clamps past 6 lines', () => {
    expect(overClampLines('1\n2\n3\n4\n5\n6')).toBe(false);
    expect(overClampLines('1\n2\n3\n4\n5\n6\n7')).toBe(true);
  });

  it('day lines only when the card spans more than one day', () => {
    const oneDay = [{ createdAt: '2026-11-08T09:00:00Z' }, { createdAt: '2026-11-08T10:00:00Z' }];
    expect([...dayBreaks(oneDay, 'UTC')]).toEqual([]);
    const two = [
      { createdAt: '2026-11-07T09:00:00Z' },
      { createdAt: '2026-11-07T10:00:00Z' },
      { createdAt: '2026-11-08T10:00:00Z' },
    ];
    expect([...dayBreaks(two, 'UTC')]).toEqual([0, 2]);
  });

  it('fill rule: at the New line when what follows is taller than the body, else the bottom', () => {
    expect(fillScrollTop({ newTop: 100, contentHeight: 2000, bodyHeight: 500 })).toBe(100);
    expect(fillScrollTop({ newTop: 1800, contentHeight: 2000, bodyHeight: 500 })).toBe(1500);
    expect(fillScrollTop({ newTop: null, contentHeight: 2000, bodyHeight: 500 })).toBe(1500);
    expect(fillScrollTop({ newTop: 0, contentHeight: 300, bodyHeight: 500 })).toBe(0);
  });

  it('m:ss', () => {
    expect(clockLength(0)).toBe('0:00');
    expect(clockLength(65.4)).toBe('1:05');
  });
});
