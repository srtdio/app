import { describe, expect, it } from 'vitest';
import { loadMoreRule } from '@/lib/load-more-rule';

describe('loadMoreRule', () => {
  it('short list, server done: every row shows, no button, no fill', () => {
    expect(loadMoreRule({ matching: 3, depth: 13, serverMore: false })).toEqual({
      shown: 3,
      hidden: 0,
      button: false,
      fill: false,
    });
  });

  it('short list, server has more: fill silently, never a button under it', () => {
    // The Briefs Open chip bug: 1 open brief among 32 closed, first page all closed.
    expect(loadMoreRule({ matching: 0, depth: 13, serverMore: true })).toEqual({
      shown: 0,
      hidden: 0,
      button: false,
      fill: true,
    });
    expect(loadMoreRule({ matching: 1, depth: 13, serverMore: true }).button).toBe(false);
  });

  it('exact depth: a button only while the server has more', () => {
    expect(loadMoreRule({ matching: 13, depth: 13, serverMore: true })).toEqual({
      shown: 13,
      hidden: 0,
      button: true,
      fill: false,
    });
    expect(loadMoreRule({ matching: 13, depth: 13, serverMore: false }).button).toBe(false);
  });

  it('hidden rows: loaded but held back by the depth show the button, server done or not', () => {
    expect(loadMoreRule({ matching: 20, depth: 13, serverMore: false })).toEqual({
      shown: 13,
      hidden: 7,
      button: true,
      fill: false,
    });
    expect(loadMoreRule({ matching: 20, depth: 13, serverMore: true }).fill).toBe(false);
  });

  it('server done after a fill: the short list ends with no button', () => {
    expect(loadMoreRule({ matching: 1, depth: 13, serverMore: false })).toEqual({
      shown: 1,
      hidden: 0,
      button: false,
      fill: false,
    });
  });

  it('a server-filtered list (depth = rows held): the button is the server alone', () => {
    expect(loadMoreRule({ matching: 40, depth: 40, serverMore: true }).button).toBe(true);
    expect(loadMoreRule({ matching: 40, depth: 40, serverMore: false }).button).toBe(false);
    expect(loadMoreRule({ matching: 0, depth: 0, serverMore: false }).button).toBe(false);
  });
});
