import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CountBadge, countBadgeText } from '@/components/ui/CountBadge';
import { SelectCheck, selectCheckClass } from '@/components/ui/SelectCheck';
import { TAG_TONE, Tag, tagClass } from '@/components/ui/Tag';

describe('CountBadge', () => {
  it('caps at 99+', () => {
    expect(countBadgeText(1)).toBe('1');
    expect(countBadgeText(99)).toBe('99');
    expect(countBadgeText(100)).toBe('99+');
    expect(renderToStaticMarkup(<CountBadge count={250} />)).toContain('>99+<');
  });

  it('renders nothing at zero or below', () => {
    expect(renderToStaticMarkup(<CountBadge count={0} />)).toBe('');
    expect(renderToStaticMarkup(<CountBadge count={-2} />)).toBe('');
    expect(renderToStaticMarkup(<CountBadge count={1} />)).toContain('data-count-badge');
  });

  it('uses the accent pill and appends caller classes', () => {
    const html = renderToStaticMarkup(<CountBadge count={3} className="border-2 border-panel" />);
    for (const token of [
      'h-[18px]',
      'min-w-[18px]',
      'bg-accent',
      'text-accent-fg',
      'border-panel',
    ]) {
      expect(html).toContain(token);
    }
  });
});

describe('SelectCheck', () => {
  it('toggles the on and off classes', () => {
    expect(selectCheckClass(true)).toContain('border-accent bg-accent text-accent-fg');
    expect(selectCheckClass(false)).toContain('border-border-strong bg-panel');
    expect(selectCheckClass(false)).not.toContain('bg-accent');
    const on = renderToStaticMarkup(<SelectCheck checked />);
    const off = renderToStaticMarkup(<SelectCheck checked={false} />);
    expect(on).toContain('data-select-check="on"');
    expect(on).toContain('<svg');
    expect(off).toContain('data-select-check="off"');
    expect(off).not.toContain('<svg');
  });
});

describe('Tag', () => {
  it('maps each tone to its token classes', () => {
    expect(TAG_TONE).toEqual({
      neutral: 'bg-panel-2 text-fg-2',
      accent: 'bg-accent-soft text-accent',
      good: 'bg-good-soft text-good',
      warn: 'bg-panel-3 text-warn',
      bad: 'bg-bad-soft text-bad',
    });
    for (const tone of ['neutral', 'accent', 'good', 'warn', 'bad'] as const) {
      expect(tagClass(tone)).toContain('inline-flex h-5 items-center rounded-md px-2 text-xs');
      expect(tagClass(tone)).toContain(TAG_TONE[tone]);
    }
  });

  it('renders an optional stage dot', () => {
    const html = renderToStaticMarkup(<Tag label="Review" dot="review" />);
    expect(html).toContain('bg-stage-review');
    expect(html).toContain('Review');
    expect(renderToStaticMarkup(<Tag label="Open" />)).not.toContain('rounded-full');
  });
});
