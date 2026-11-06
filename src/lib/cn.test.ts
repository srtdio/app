import { describe, expect, it } from 'vitest';
import { cn } from './cn';

describe('cn', () => {
  it('later spacing wins', () => {
    expect(cn('p-4', 'p-3')).toBe('p-3');
    expect(cn('gap-3', 'gap-2')).toBe('gap-2');
  });

  it('keeps a Sorted text size and a text colour together', () => {
    expect(cn('text-md', 'text-fg')).toBe('text-md text-fg');
    expect(cn('text-sm', 'text-fg-2')).toBe('text-sm text-fg-2');
    expect(cn('text-base', 'text-fg-3')).toBe('text-base text-fg-3');
    expect(cn('text-input', 'text-accent')).toBe('text-input text-accent');
    expect(cn('text-legacy-sm', 'text-strip')).toBe('text-legacy-sm text-strip');
  });

  it('keeps an arbitrary size beside an arbitrary or token colour', () => {
    expect(cn('text-[11px] leading-[15px]', 'text-fg-3')).toBe(
      'text-[11px] leading-[15px] text-fg-3',
    );
    expect(cn('text-[17px]', 'text-[color:var(--bubble-meta-own)]')).toBe(
      'text-[17px] text-[color:var(--bubble-meta-own)]',
    );
    expect(cn('text-md', 'text-[var(--guide-ink)]')).toBe('text-md text-[var(--guide-ink)]');
    expect(cn('text-[11px]', 'text-md')).toBe('text-md');
  });

  it('later text size wins over an earlier size', () => {
    expect(cn('text-base', 'text-lg')).toBe('text-lg');
    expect(cn('text-legacy-sm', 'text-md')).toBe('text-md');
    expect(cn('text-input', 'text-base')).toBe('text-base');
  });

  it('later text colour wins over an earlier colour', () => {
    expect(cn('text-fg', 'text-fg-3')).toBe('text-fg-3');
  });

  it('keeps leading-* beside a size (CSS order decides, as before)', () => {
    expect(cn('leading-5', 'text-md')).toBe('leading-5 text-md');
  });

  it('merges radii including the custom keys', () => {
    expect(cn('rounded-lg', 'rounded-full')).toBe('rounded-full');
    expect(cn('rounded-card', 'rounded-sheet')).toBe('rounded-sheet');
    expect(cn('rounded-xl', 'rounded-pill')).toBe('rounded-pill');
  });

  it('keeps a background image on top of a background colour', () => {
    expect(cn('bg-panel', 'bg-good-tint')).toBe('bg-panel bg-good-tint');
    expect(cn('bg-panel', 'bg-panel-2')).toBe('bg-panel-2');
  });

  it('never drops lit-* or mv-* classes', () => {
    expect(cn('lit-card')).toBe('lit-card');
    expect(cn('lit-card', 'lit-selected', 'bg-panel', 'p-4')).toBe(
      'lit-card lit-selected bg-panel p-4',
    );
    expect(cn('lit-well', 'focus-visible:lit-focus', 'lit-hover')).toBe(
      'lit-well focus-visible:lit-focus lit-hover',
    );
    expect(cn('mv-push', 'mv-rise', 'p-2')).toBe('mv-push mv-rise p-2');
  });

  it('drops falsy parts', () => {
    expect(cn('a', false, null, undefined, '', 'b')).toBe('a b');
    expect(cn()).toBe('');
  });
});
