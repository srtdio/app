// Guard: the type, radius, spacing, edge and stacking scales locked in
// CLAUDE.md (Design and Layout rules). They live in theme (not extend), so
// Tailwind's defaults are gone and only these values exist as classes.

import { describe, expect, it } from 'vitest';
import tailwindConfig from '../../tailwind.config';

const theme = tailwindConfig.theme;
const extend = theme.extend;

describe('design tokens: type and radius scales', () => {
  it('fontSize is the locked scale, nothing else', () => {
    expect(theme.fontSize).toEqual({
      xs: ['11px', '14px'],
      sm: ['12px', '16px'],
      md: ['13px', '18px'],
      base: ['14px', '20px'],
      lg: ['15px', '20px'],
      xl: ['17px', '22px'],
      '2xl': ['20px', '26px'],
      '3xl': ['28px', '34px'],
      input: ['16px', '22px'],
    });
    expect(extend).not.toHaveProperty('fontSize');
  });

  it('borderRadius is 8 for controls and cards, 12 popovers, 16 sheets', () => {
    expect(theme.borderRadius).toEqual({
      DEFAULT: '8px',
      none: '0',
      sm: '6px',
      md: '8px',
      lg: '8px',
      xl: '12px',
      '2xl': '16px',
      full: '9999px',
      inset: '4px',
      card: '8px',
      sheet: '16px',
      pill: '9999px',
    });
    expect(extend).not.toHaveProperty('borderRadius');
  });

  it('spacing is the 4px grid plus px, 0.5 and 1.5; no 2.5 or 3.5', () => {
    const keys = Object.keys(theme.spacing);
    expect(keys).toEqual(expect.arrayContaining(['px', '0', '0.5', '1.5', '11', '13', '15', '17', '18']));
    expect(keys).not.toContain('2.5');
    expect(keys).not.toContain('3.5');
    for (const [key, value] of Object.entries(theme.spacing)) {
      if (key === 'px' || key === '0' || key === '0.5' || key === '1.5') continue;
      expect(Number(key) * 0.25 + 'rem').toBe(value);
    }
    expect(extend).not.toHaveProperty('spacing');
  });

  it('border widths are 1 and 2 plus the named cut-out rings and the quote rail', () => {
    expect(theme.borderWidth).toEqual({
      DEFAULT: '1px',
      0: '0px',
      2: '2px',
      cutout: '3px',
      'cutout-lg': '4px',
      rail: '4px',
    });
  });

  it('leading and tracking exist only for the emoji glyph and the type roles', () => {
    expect(theme.lineHeight).toEqual({ emoji: '1' });
    expect(theme.letterSpacing).toEqual({ tight: '-0.025em', label: '0.06em' });
  });

  it('z-index is the named stacking scale, in order', () => {
    expect(theme.zIndex).toEqual({
      base: '0',
      raised: '10',
      sticky: '20',
      nav: '30',
      dock: '40',
      sheet: '50',
      guide: '55',
      'picker-catch': '56',
      picker: '57',
      dialog: '60',
      toast: '70',
      viewer: '80',
      top: '2147483000',
    });
  });

  it('text-accent reads accent-text and bg-accent reads accent-fill', () => {
    expect(extend.textColor.accent).toBe('rgb(var(--accent-text-rgb) / <alpha-value>)');
    expect(extend.backgroundColor.accent).toBe('rgb(var(--accent-fill-rgb) / <alpha-value>)');
    expect(extend.colors.accent).toBe('rgb(var(--accent-rgb) / <alpha-value>)');
  });
});
