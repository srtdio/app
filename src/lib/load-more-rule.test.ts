import { describe, expect, it } from 'vitest';
import { activityLoadMore, loadMoreRule, rowsInHeight } from '@/lib/load-more-rule';

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

describe('activityLoadMore: Activity counts item rows, never entries', () => {
  const layout = (sections: number[]) => ({
    sections,
    columns: 1,
    rowPx: 72,
    headingPx: 32,
    gapPx: 24,
  });

  it('20 entries collapsed into 5 rows: short of the depth, fills silently, no button', () => {
    const d = activityLoadMore({
      layout: layout([3, 2]),
      listTop: 120,
      viewportH: 664,
      taps: 0,
      serverMore: true,
    });
    expect(d).toMatchObject({ shown: 5, button: false, fill: true });
  });

  it('rows past 1.45 viewports are held back behind Load more', () => {
    const d = activityLoadMore({
      layout: layout([30]),
      listTop: 120,
      viewportH: 664,
      taps: 0,
      serverMore: false,
    });
    // (1.45 * 664 - 120 - 32) / 72 = 11.26 -> 11 rows.
    expect(d).toMatchObject({ shown: 11, hidden: 19, button: true, fill: false });
    const more = activityLoadMore({
      layout: layout([30]),
      listTop: 120,
      viewportH: 664,
      taps: 1,
      serverMore: false,
    });
    expect(more.shown).toBe(20);
  });

  it('short list, server done: every row, no button', () => {
    expect(
      activityLoadMore({
        layout: layout([2]),
        listTop: 120,
        viewportH: 664,
        taps: 0,
        serverMore: false,
      }),
    ).toMatchObject({ shown: 2, button: false, fill: false });
  });

  it('rowsInHeight: a 2-line row counts its real height (density + 20)', () => {
    const l = { sections: [5], columns: 1, rowPx: 72, headingPx: 32, gapPx: 24 };
    // 32 + 4 x 72 = 320 fits 4 rows; with the 2nd row 92 tall only 3 fit.
    expect(rowsInHeight(l, 320)).toEqual({ rows: 4, reached: true });
    expect(rowsInHeight({ ...l, rowHeights: [72, 92, 72, 72] }, 320)).toEqual({
      rows: 3,
      reached: true,
    });
  });

  it('rowsInHeight: headings, gaps and laptop columns count', () => {
    const l = { sections: [4, 4], columns: 2, rowPx: 72, headingPx: 32, gapPx: 24 };
    // 32 + 72 + 72 = 176: 4 rows; then 24 + 32 + 72 = 304: 6 rows.
    expect(rowsInHeight(l, 176)).toEqual({ rows: 4, reached: true });
    expect(rowsInHeight(l, 304)).toEqual({ rows: 6, reached: true });
    expect(rowsInHeight(l, 10_000)).toEqual({ rows: 8, reached: false });
  });
});
