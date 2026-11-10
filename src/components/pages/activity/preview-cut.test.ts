import { describe, expect, it } from 'vitest';
import { cutPreview, PREVIEW_MORE, stripCutEnd } from '@/components/pages/activity/preview-cut';

// One unit per character: a 20 wide line holds 20 characters.
const measure = (s: string): number => s.length;

describe('cutPreview', () => {
  it('short text: whole, one line, no marker', () => {
    expect(cutPreview('Priya: looks good', 20, measure)).toEqual({
      text: 'Priya: looks good',
      cut: false,
      lines: 1,
    });
  });

  it('text that fits 2 lines: whole, no marker (never hides a word or two)', () => {
    // 2 lines of 20: "aaaa bbbb cccc dddd" / "eeee ffff gggg hhhh".
    const text = 'aaaa bbbb cccc dddd eeee ffff gggg hhhh';
    expect(cutPreview(text, 20, measure)).toEqual({ text, cut: false, lines: 2 });
  });

  it('longer text: cut at the last whole word that fits 2 lines with "… more"', () => {
    const text = 'aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj';
    const got = cutPreview(text, 20, measure);
    expect(got.cut).toBe(true);
    expect(got.lines).toBe(2);
    // Whole words only: the cut ends on a full word of the text.
    expect(text.startsWith(got.text)).toBe(true);
    expect(text.charAt(got.text.length)).toBe(' ');
    expect(got.text).toBe('aaaa bbbb cccc dddd eeee ffff gggg');
    expect(`${got.text}${PREVIEW_MORE}`.length).toBeLessThanOrEqual(20 + 1 + 20);
  });

  it('never mid-word, even with a long word at the cut', () => {
    const text = 'one two three four five six seven eight nine extraordinarily ten eleven';
    const got = cutPreview(text, 20, measure);
    expect(got.cut).toBe(true);
    expect(text.split(' ')).toEqual(expect.arrayContaining(got.text.split(' ')));
  });

  it('strips trailing space and punctuation before the ellipsis', () => {
    expect(stripCutEnd('tighten the caption, ')).toBe('tighten the caption');
    expect(stripCutEnd('swap the hero.')).toBe('swap the hero');
    const got = cutPreview('aaaa, bbbb, cccc, dddd, eeee, ffff, gggg, hhhh, iiii', 20, measure);
    expect(got.text.endsWith(',')).toBe(false);
  });

  it('a long unbroken link counts the lines its width needs; the cut still fits 2', () => {
    const link = `https://example.com/${'a'.repeat(80)}`;
    const got = cutPreview(`${link} and more words after it`, 20, measure);
    expect(got.cut).toBe(true);
    expect(got.lines).toBe(2);
    expect(`${got.text}${PREVIEW_MORE}`.length).toBeLessThanOrEqual(40);
  });
});
