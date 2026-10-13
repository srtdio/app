import { describe, expect, it } from 'vitest';
import { continueList, isListNewlineKeydown } from '@/lib/chat/list-continue';

describe('continueList', () => {
  it('continues a numbered line with the next number, caret after the marker', () => {
    const value = '1. a';
    expect(continueList(value, value.length)).toEqual({ value: '1. a\n2. ', caret: 8 });
  });

  it('ends the list on an empty marker: the marker goes, nothing is inserted', () => {
    const value = '1. a\n2. ';
    expect(continueList(value, value.length)).toEqual({ value: '1. a\n', caret: 5 });
    expect(continueList('3) ', 3)).toEqual({ value: '', caret: 0 });
  });

  it('keeps the ")" delimiter', () => {
    expect(continueList('4) brief', 8)).toEqual({ value: '4) brief\n5) ', caret: 12 });
  });

  it('is a no-op mid-paragraph and on lines that are not items', () => {
    expect(continueList('Hello there', 5)).toBeNull();
    expect(continueList('see 1. this', 11)).toBeNull();
    expect(continueList('1.no space', 10)).toBeNull();
    expect(continueList('1. ', 1)).toEqual({ value: '', caret: 0 });
    expect(continueList('', 0)).toBeNull();
  });

  it('handles 3-digit numbers (and not 4)', () => {
    expect(continueList('999. last', 9)).toEqual({ value: '999. last\n1000. ', caret: 16 });
    expect(continueList('1000. x', 7)).toBeNull();
  });

  it('reads the caret line in a longer text and replaces a selection', () => {
    const value = 'Intro\n1. one\n2. two\nOutro';
    const end = value.indexOf('\nOutro');
    expect(continueList(value, end)?.value).toBe('Intro\n1. one\n2. two\n3. \nOutro');
    expect(continueList('1. abc', 4, 6)).toEqual({ value: '1. a\n2. ', caret: 8 });
  });
});

describe('isListNewlineKeydown', () => {
  const base = {
    key: 'Enter',
    shiftKey: false,
    isComposing: false,
    coarsePointer: false,
    pickerOpen: false,
  };
  it('touch: Enter; laptop: Shift+Enter', () => {
    expect(isListNewlineKeydown({ ...base, coarsePointer: true })).toBe(true);
    expect(isListNewlineKeydown({ ...base, shiftKey: true })).toBe(true);
    expect(isListNewlineKeydown(base)).toBe(false);
  });
  it('never mid-IME, with the mention picker open, or for another key', () => {
    expect(isListNewlineKeydown({ ...base, shiftKey: true, isComposing: true })).toBe(false);
    expect(isListNewlineKeydown({ ...base, coarsePointer: true, pickerOpen: true })).toBe(false);
    expect(isListNewlineKeydown({ ...base, key: 'a', coarsePointer: true })).toBe(false);
  });
});
