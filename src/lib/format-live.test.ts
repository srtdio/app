// WYSIWYG formatting (src/lib/format-live.ts): paired markers held hidden at
// the same length, broken pairs dropped, text typed beside hidden markers
// landing on the side that keeps them, combined styles, caret stepping and
// deleting past hidden markers, and the box's own undo.
import { describe, expect, it } from 'vitest';
import { parseFormat } from '@srtdio/comments';
import {
  HIDDEN_MARKER,
  decodeMarkers,
  deleteBesideHidden,
  encodeMarkers,
  historyPush,
  historyStart,
  historyStep,
  isHiddenMarker,
  liveEdit,
  liveSegments,
  normalizeLive,
  pairedMarkerCount,
  stepOverHidden,
  stripHiddenMarkers,
  togglePendingStyle,
  wrapMarkers,
} from '@/lib/format-live';

const B = HIDDEN_MARKER['*'] ?? '';
const I = HIDDEN_MARKER._ ?? '';
const S = HIDDEN_MARKER['~'] ?? '';
const U = HIDDEN_MARKER['+'] ?? '';

/** What a reader sees in the box: the held text with its hidden markers gone. */
const shown = (held: string): string => stripHiddenMarkers(held);

describe('encode / decode: same length, saved text unchanged', () => {
  it('hides a formed pair and gives the saved text back', () => {
    const saved = 'ship *today*';
    const held = encodeMarkers(saved);
    expect(held).toBe(`ship ${B}today${B}`);
    expect(held).toHaveLength(saved.length);
    expect(decodeMarkers(held)).toBe(saved);
    expect(shown(held)).toBe('ship today');
    expect(held).not.toContain('*');
  });

  it('every style hides; the hidden code points are zero-width format characters', () => {
    for (const [ch, cp] of Object.entries(HIDDEN_MARKER)) {
      expect(cp).toHaveLength(1);
      expect(/\p{Cf}/u.test(cp)).toBe(true);
      expect(isHiddenMarker(cp)).toBe(true);
      expect(isHiddenMarker(ch)).toBe(false);
    }
    const mono = '\u2060\u2060\u2060';
    expect(encodeMarkers('_a_ ~b~ +c+ ```d```')).toBe(
      `${I}a${I} ${S}b${S} ${U}c${U} ${mono}d${mono}`,
    );
  });

  it('an unpaired star stays a plain, visible character', () => {
    expect(encodeMarkers('2*3 and *start')).toBe('2*3 and *start');
    expect(encodeMarkers('snake_case_name')).toBe('snake_case_name');
  });

  it('round trips any saved text exactly (parseFormat sees the same thing)', () => {
    for (const saved of [
      '',
      'plain',
      '*a* _b_ ~c~ +d+',
      '*_+~all four~+_*',
      'mid*word* stays',
      '> *quote* line\n- _item_\n1. +one+',
      'a @[11111111-2222-3333-4444-555555555555] *b*',
      'see https://x.test/a_b_c *ok*',
    ]) {
      const held = encodeMarkers(saved);
      expect(held).toHaveLength(saved.length);
      expect(decodeMarkers(held)).toBe(saved);
      expect(parseFormat(decodeMarkers(held))).toEqual(parseFormat(saved));
    }
  });
});

describe('combined styles', () => {
  it('bold, italic, underline and strike on the same words: one run, no marker shows', () => {
    const saved = '*_+~both~+_* and more';
    const held = encodeMarkers(saved);
    expect(shown(held)).toBe('both and more');
    const styled = liveSegments(held).filter((s) => !s.marker && s.styles.length > 0);
    expect(styled).toHaveLength(1);
    expect(styled[0]?.text).toBe('both');
    expect([...(styled[0]?.styles ?? [])].sort()).toEqual([
      'bold',
      'italic',
      'strike',
      'underline',
    ]);
  });

  it('segments line up with every offset (markers are their own zero-width runs)', () => {
    const held = encodeMarkers('a *b* c');
    const segs = liveSegments(held);
    expect(segs.map((s) => s.text).join('')).toBe(held);
    expect(segs.filter((s) => s.marker).map((s) => s.text)).toEqual([B, B]);
  });

  it('wrapMarkers opens outer to inner and closes in reverse', () => {
    expect(wrapMarkers(['italic', 'bold'])).toEqual({ open: '*_', close: '_*' });
    expect(wrapMarkers(['strike', 'underline', 'bold', 'italic'])).toEqual({
      open: '*_+~',
      close: '~+_*',
    });
  });
});

describe('normalizeLive', () => {
  it('typing the closing star hides both stars, caret kept', () => {
    const r = normalizeLive('ship *today*', 12, 12);
    expect(r).toEqual({ text: `ship ${B}today${B}`, start: 12, end: 12 });
  });

  it('a hidden marker whose pair broke goes away, never shows; the caret follows', () => {
    // "*a*" with the "a" deleted: both hidden stars go.
    const r = normalizeLive(`x ${B}${B} y`, 4, 4);
    expect(r.text).toBe('x  y');
    expect(r.start).toBe(2);
    expect(r.text).not.toContain('*');
  });

  it('leaves plain text alone', () => {
    expect(normalizeLive('hello', 2, 3)).toEqual({ text: 'hello', start: 2, end: 3 });
  });
});

describe('liveEdit: text typed beside hidden markers', () => {
  const held = encodeMarkers('*hello*');

  it('a letter after a bold word stays bold (lands before the closing marker)', () => {
    const r = liveEdit(held, `${held}x`, { start: 8, end: 8 });
    expect(decodeMarkers(r.text)).toBe('*hellox*');
    expect(r.start).toBe(7);
    expect(shown(r.text)).toBe('hellox');
  });

  it('a space after a bold word stays outside (the pair holds)', () => {
    const r = liveEdit(held, `${held} `, { start: 8, end: 8 });
    expect(decodeMarkers(r.text)).toBe('*hello* ');
    expect(r.start).toBe(8);
  });

  it('a letter before a bold word joins it', () => {
    const r = liveEdit(held, `x${held}`, { start: 1, end: 1 });
    expect(decodeMarkers(r.text)).toBe('*xhello*');
    expect(shown(r.text)).toBe('xhello');
  });

  it('pending styles wrap the next typed word, caret inside so typing continues', () => {
    const r = liveEdit('go ', 'go n', { start: 4, end: 4 }, ['bold', 'italic']);
    expect(r.usedPending).toBe(true);
    expect(decodeMarkers(r.text)).toBe('go *_n_*');
    expect(r.start).toBe(6);
    const next = liveEdit(r.text, `${r.text.slice(0, 6)}o${r.text.slice(6)}`, {
      start: 7,
      end: 7,
    });
    expect(decodeMarkers(next.text)).toBe('go *_no_*');
    expect(shown(next.text)).toBe('go no');
  });

  it('pending styles wait while a space is typed', () => {
    const r = liveEdit('go', 'go ', { start: 3, end: 3 }, ['bold']);
    expect(r.usedPending).toBe(false);
    expect(r.text).toBe('go ');
  });

  it('a pasted marked phrase hides its markers', () => {
    const r = liveEdit('', 'a *b* c', { start: 7, end: 7 });
    expect(shown(r.text)).toBe('a b c');
    expect(pairedMarkerCount(decodeMarkers(r.text))).toBe(2);
  });
});

describe('caret and delete past hidden markers', () => {
  const held = encodeMarkers('ab *cd* ef');

  it('an arrow steps over hidden markers and one visible character', () => {
    // held: a b ␠ [*] c d [*] ␠ e f (indices 0..9).
    // Caret before "c": right goes past "c" (nothing hidden on the way).
    expect(stepOverHidden(held, 4, 1)).toBe(5);
    // Caret just before the closing marker: right goes past it and the space.
    expect(stepOverHidden(held, 6, 1)).toBe(8);
    // Caret just after the opening marker: left goes past it and the space.
    expect(stepOverHidden(held, 4, -1)).toBe(2);
  });

  it('Backspace beside a hidden marker deletes the visible character before it', () => {
    // Caret after the closing marker: "d" goes, the pair stays.
    expect(deleteBesideHidden(held, 7, -1)).toEqual({ from: 5, to: 6 });
    // No hidden marker before the caret: the browser's own delete.
    expect(deleteBesideHidden(held, 2, -1)).toBeNull();
  });

  it('Delete beside a hidden marker deletes the visible character after it', () => {
    expect(deleteBesideHidden(held, 3, 1)).toEqual({ from: 4, to: 5 });
  });

  it('a surrogate pair is one character', () => {
    const t = `${B}😀${B}`;
    expect(stepOverHidden(t, 0, 1)).toBe(3);
  });
});

describe('the box own undo', () => {
  it('typing within a second merges into one step; undo and redo walk the states', () => {
    let h = historyStart({ text: '', start: 0, end: 0 });
    h = historyPush(h, { text: 'a', start: 1, end: 1 }, 'type', 1000);
    h = historyPush(h, { text: 'ab', start: 2, end: 2 }, 'type', 1500);
    h = historyPush(h, { text: '*ab*', start: 3, end: 3 }, 'format', 1600);
    expect(h.stack.map((s) => s.text)).toEqual(['', 'ab', '*ab*']);
    const back = historyStep(h, -1);
    expect(back?.snap.text).toBe('ab');
    const back2 = back !== null ? historyStep(back.history, -1) : null;
    expect(back2?.snap.text).toBe('');
    const fwd = back2 !== null ? historyStep(back2.history, 1) : null;
    expect(fwd?.snap.text).toBe('ab');
    expect(historyStep(historyStart({ text: '', start: 0, end: 0 }), -1)).toBeNull();
  });

  it('a new edit after undo drops the redo branch', () => {
    let h = historyStart({ text: '', start: 0, end: 0 });
    h = historyPush(h, { text: 'x', start: 1, end: 1 }, 'paste', 0);
    h = historyPush(h, { text: 'xy', start: 2, end: 2 }, 'paste', 10);
    const back = historyStep(h, -1);
    expect(back).not.toBeNull();
    if (back === null) return;
    const branched = historyPush(back.history, { text: 'xz', start: 2, end: 2 }, 'paste', 20);
    expect(branched.stack.map((s) => s.text)).toEqual(['', 'x', 'xz']);
  });
});

describe('togglePendingStyle', () => {
  it('adds and removes a style', () => {
    expect(togglePendingStyle([], 'bold')).toEqual(['bold']);
    expect(togglePendingStyle(['bold', 'italic'], 'bold')).toEqual(['italic']);
  });
});
