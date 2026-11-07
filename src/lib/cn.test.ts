import { describe, expect, it } from 'vitest';
import { cn } from '@/lib/cn';

describe('cn: tailwind-merge on the custom scale', () => {
  it('the last padding wins', () => {
    expect(cn('p-4', 'p-3')).toBe('p-3');
  });
  it('a size and a colour on text-* are both kept', () => {
    expect(cn('text-md', 'text-fg')).toBe('text-md text-fg');
    expect(cn('text-input', 'text-fg-2', 'md:text-base')).toBe('text-input text-fg-2 md:text-base');
  });
  it('two sizes merge, two colours merge', () => {
    expect(cn('text-sm', 'text-base')).toBe('text-base');
    expect(cn('text-fg', 'text-fg-3')).toBe('text-fg-3');
  });
  it('named tokens join their groups (tailwind.config.ts value lock)', () => {
    expect(cn('z-dock', 'z-sheet')).toBe('z-sheet');
    expect(cn('w-full', 'w-side-panel')).toBe('w-side-panel');
    expect(cn('py-2', 'py-field-y')).toBe('py-field-y');
    expect(cn('border-cutout', 'border-bg')).toBe('border-cutout border-bg');
    expect(cn('text-2xl', 'leading-emoji')).toBe('text-2xl leading-emoji');
    expect(cn('tracking-tight', 'tracking-label')).toBe('tracking-label');
  });
  it('radius: the later wins, custom radii included', () => {
    expect(cn('rounded-lg', 'rounded-full')).toBe('rounded-full');
    expect(cn('rounded-lg', 'rounded-card')).toBe('rounded-card');
  });
  it('lit-* and mv-* are never dropped', () => {
    expect(cn('lit-card', 'lit-hover', 'p-4')).toBe('lit-card lit-hover p-4');
    expect(cn('mv-press', 'mv-tint', 'focus-visible:lit-focus')).toBe(
      'mv-press mv-tint focus-visible:lit-focus',
    );
  });
  it('a background image token never drops a background colour', () => {
    expect(cn('bg-transparent', 'bg-on-bubble-hover')).toBe('bg-transparent bg-on-bubble-hover');
    expect(cn('bg-panel', 'bg-good-tint')).toBe('bg-panel bg-good-tint');
  });
  it('skips falsy parts', () => {
    expect(cn('a', false, null, undefined, '', 'b')).toBe('a b');
  });
});
