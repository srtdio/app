import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@/lib/use-media-query', () => ({ useMediaQuery: () => true }));
vi.mock('@/components/pages/pipeline/PipelineDateRangeCalendar', () => ({
  PipelineDateRangeCalendar: () => null,
}));

import {
  PipelineDateControl,
  PipelineSortControl,
} from '@/components/pages/pipeline/PipelineSortControl';
import { StageChips } from '@/components/pages/pipeline/StageChips';

// Button system: the Sort / Due date triggers and the stage chips are the
// shared 44px / 8px-radius Button.

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
  expect(cls).toContain('text-sm');
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

  it('stage chips are shared 44px buttons with an 8px radius', () => {
    const html = renderToStaticMarkup(
      <StageChips
        items={[
          { key: 'all', label: 'All', count: 3 },
          { key: 'review', label: 'Review', count: 1, stage: 'review' },
        ]}
        active="review"
        onChange={() => {}}
      />,
    );
    const tags = buttonTags(html);
    expect(tags).toHaveLength(2);
    for (const tag of tags) expectShared(tag);
    const active = tags.find((tag) => tag.includes('aria-current="true"'));
    expect(classOf(active ?? '')).toContain('bg-accent-soft');
  });
});
