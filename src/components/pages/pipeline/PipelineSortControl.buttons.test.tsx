import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => true,
}));
vi.mock('@/components/pages/pipeline/PipelineDateRangeCalendar', () => ({
  PipelineDateRangeCalendar: () => null,
}));

import {
  PipelineDateControl,
  PipelineSortControl,
} from '@/components/pages/pipeline/PipelineSortControl';
import { StageChips } from '@/components/pages/pipeline/StageChips';

// Button system: the Sort / Due date triggers are the shared 44px /
// 8px-radius Button; the stage chips are the shared ui/Chip.

function buttonTags(html: string): string[] {
  return html.match(/<button[^>]*>/g) ?? [];
}

function classOf(tag: string): string[] {
  return (/class="([^"]*)"/.exec(tag)?.[1] ?? '').split(/\s+/);
}

function expectShared(tag: string): void {
  const cls = classOf(tag);
  expect(cls).toContain('h-11');
  expect(cls).toContain('rounded-lg');
  expect(cls).toContain('text-base');
  expect(cls).toContain('font-medium');
  for (const old of ['h-9', 'h-12', 'rounded-md', 'rounded-full', 'font-semibold', 'px-3']) {
    expect(cls).not.toContain(old);
  }
}

describe('Pipeline controls buttons', () => {
  it('Sort and Due date triggers are shared secondary buttons', () => {
    const sort = buttonTags(
      renderToStaticMarkup(<PipelineSortControl order="updated" onOrderChange={() => {}} />),
    ).find((tag) => tag.includes('aria-label="Sort"'));
    const due = buttonTags(
      renderToStaticMarkup(
        <PipelineDateControl
          dateWindow="week"
          onDateWindowChange={() => {}}
          customRange={null}
          onCustomRangeChange={() => {}}
          weekStartDay={1}
        />,
      ),
    ).find((tag) => tag.includes('data-date-filter'));
    if (sort === undefined || due === undefined) throw new Error('missing trigger');
    for (const tag of [sort, due]) {
      expectShared(tag);
      expect(classOf(tag)).toContain('min-w-11');
    }
    expect(classOf(due)).toContain('border-accent-line');
  });

  it('stage chips are the shared ui/Chip: 44px, 8px radius, count only above 0', () => {
    const html = renderToStaticMarkup(
      <StageChips
        items={[
          { key: 'all', label: 'All', count: 3 },
          { key: 'review', label: 'Review', count: 1, stage: 'review' },
          { key: 'parked', label: 'Parked', count: 0, stage: 'parked' },
        ]}
        active="review"
        onChange={() => {}}
      />,
    );
    const tags = buttonTags(html);
    expect(tags).toHaveLength(3);
    for (const tag of tags) {
      expect(classOf(tag)).toContain('min-h-[44px]');
      expect(classOf(tag)).toContain('rounded-lg');
    }
    const active = tags.find((tag) => tag.includes('aria-current="true"'));
    expect(classOf(active ?? '')).toContain('bg-accent-soft');
    expect(html).toContain('<span class="tabular-nums">3</span>');
    expect(html).toContain('<span class="tabular-nums">1</span>');
    expect(html).not.toContain('<span class="tabular-nums">0</span>');
  });

  it('reads the one breakpoint, and its laptop popover closes on Escape and returns focus', () => {
    const src = readFileSync(
      fileURLToPath(new URL('./PipelineSortControl.tsx', import.meta.url)),
      'utf8',
    );
    expect(src).not.toMatch(/useMediaQuery|use-media-query|matchMedia/);
    expect(src.match(/useIsLaptop\(\)/g)).toHaveLength(3);
    expect(src).toContain(
      'useDismissLayer(props.isDesktop && props.open, props.onClose, panelRef);',
    );
  });
});
