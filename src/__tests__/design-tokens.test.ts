// Guard: the type and radius scales locked in CLAUDE.md (Design rules). The
// legacy-* sizes freeze the old Tailwind scale until the type migration PR.

import { describe, expect, it } from 'vitest';
import tailwindConfig from '../../tailwind.config';

const extend = tailwindConfig.theme.extend;

describe('design tokens: type and radius scales', () => {
  it('fontSize is the locked scale plus the legacy aliases', () => {
    expect(extend.fontSize).toEqual({
      xs: ['11px', '14px'],
      sm: ['12px', '16px'],
      md: ['13px', '18px'],
      base: ['14px', '20px'],
      lg: ['15px', '20px'],
      xl: ['17px', '22px'],
      '2xl': ['20px', '26px'],
      '3xl': ['28px', '34px'],
      'legacy-xs': ['12px', '16px'],
      'legacy-sm': ['14px', '20px'],
      'legacy-base': ['16px', '24px'],
      'legacy-lg': ['18px', '28px'],
      'legacy-xl': ['20px', '28px'],
      'legacy-2xl': ['24px', '32px'],
      'legacy-3xl': ['30px', '36px'],
    });
  });

  it('borderRadius is 8 for controls and cards, 12 popovers, 16 sheets', () => {
    expect(extend.borderRadius).toEqual({
      DEFAULT: '8px',
      none: '0',
      sm: '6px',
      md: '8px',
      lg: '8px',
      xl: '12px',
      '2xl': '16px',
      full: '9999px',
      card: '8px',
      sheet: '16px',
      pill: '9999px',
    });
  });

  it('text-accent reads accent-text and bg-accent reads accent-fill', () => {
    expect(extend.textColor.accent).toBe('rgb(var(--accent-text-rgb) / <alpha-value>)');
    expect(extend.backgroundColor.accent).toBe('rgb(var(--accent-fill-rgb) / <alpha-value>)');
    expect(extend.colors.accent).toBe('rgb(var(--accent-rgb) / <alpha-value>)');
  });
});
