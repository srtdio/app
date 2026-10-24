import { describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { renderToStaticMarkup } from 'react-dom/server';
import { PlanRowEditButtons } from '@/components/chat/PlanRowActions';
import { RemoveFromPlanButton } from '@/components/chat/PlanMoveSheet';

const noop = (): void => undefined;
const OLD = /\bh-8\b|\bh-9\b|\bh-10\b|\bh-12\b|rounded-md|rounded-xl|font-semibold|text-\[13px\]/;

function buttonTags(html: string): string[] {
  return html.match(/<button[^>]*>/g) ?? [];
}

describe('plan row buttons (design system)', () => {
  it('day chip and remove are 44px with the 8px radius', () => {
    const html = renderToStaticMarkup(
      <PlanRowEditButtons
        title="Reel"
        dayLabel="Wed 14"
        dayOpen={false}
        onDay={noop}
        onRemove={noop}
      />,
    );
    const tags = buttonTags(html);
    expect(tags).toHaveLength(2);
    for (const tag of tags) {
      expect(tag).toContain('h-11');
      expect(tag).toContain('rounded-lg');
      expect(tag).not.toMatch(OLD);
    }
    const chip = tags.find((t) => t.includes('data-plan-row-day-chip')) ?? '';
    expect(chip).toContain('border-border');
    expect(chip).toContain('aria-label="Change day: Reel"');
    const remove = tags.find((t) => t.includes('data-plan-row-remove-edit')) ?? '';
    expect(remove).toContain('w-11');
    expect(remove).toContain('text-bad');
    expect(remove).toContain('aria-label="Remove from plan: Reel"');
    expect(html).toContain('>Wed 14<');
  });

  it('Remove from plan is the full-width danger button', () => {
    const html = renderToStaticMarkup(<RemoveFromPlanButton busy={false} onClick={noop} />);
    const [tag = ''] = buttonTags(html);
    expect(tag).toContain('h-11');
    expect(tag).toContain('rounded-lg');
    expect(tag).toContain('bg-bad-solid');
    expect(tag).toContain('w-full');
    expect(tag).not.toMatch(OLD);
  });
});
