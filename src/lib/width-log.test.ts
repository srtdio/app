// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { formatWidths, readWidths } from '@/lib/width-log';

describe('width log', () => {
  it('formats a reading: the figures, then one line per element past an edge', () => {
    const text = formatWidths({
      focus: 'textarea',
      screen: 440,
      innerWidth: 440,
      page: 515,
      scale: 1,
      offsetLeft: 21,
      culprits: [{ label: 'div[writingBox]', left: 40, right: 515, width: 475 }],
    });
    expect(text.split('\n')).toEqual([
      'Widths after focus on: textarea',
      'screen 440 inner 440 page 515 scale 1 offsetLeft 21',
      '40..515 (475) div[writingBox]',
    ]);
  });

  it('says so before any focus', () => {
    expect(formatWidths(null)).toBe('Widths: no focus read yet');
  });

  it('reads a page and never throws', () => {
    document.body.innerHTML = '<div data-a="">x</div>';
    const s = readWidths('x');
    expect(s?.focus).toBe('x');
    expect(Array.isArray(s?.culprits)).toBe(true);
  });
});
