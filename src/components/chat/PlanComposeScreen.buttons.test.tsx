import { describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/components/chat/AssetPicker', () => ({ AssetPicker: () => null }));

import { renderToStaticMarkup } from 'react-dom/server';
import { ComposeItemRow } from '@/components/chat/PlanComposeScreen';
import type { ComposeConcept, ComposePost } from '@/lib/chat/plans';

const noop = (): void => undefined;
const OLD = /\bh-8\b|\bh-9\b|\bh-10\b|\bh-12\b|rounded-md|rounded-xl|rounded-\[10px\]|font-semibold/;

const C: ComposeConcept = {
  kind: 'concept',
  key: 'k1',
  title: 'Plant tour reel',
  description: 'A walk through the plant.',
  files: [],
  day: '2026-10-13',
};
const P: ComposePost = {
  kind: 'post',
  key: 'p1',
  title: 'Festive teaser carousel',
  stage: 'review',
  orig: '2026-11-02',
  day: null,
  chosen: false,
};

function tagOf(html: string, attr: string): string {
  const at = html.indexOf(attr);
  if (at < 0) return '';
  const start = html.lastIndexOf('<button', at);
  return html.slice(start, html.indexOf('>', at) + 1);
}

describe('New plan row buttons (design system)', () => {
  for (const item of [C, P]) {
    it(`${item.kind}: the day button and the remove are 44px, 8px radius`, () => {
      const html = renderToStaticMarkup(
        <ComposeItemRow item={item} onDay={noop} onEdit={noop} onRemove={noop} />,
      );
      const day = tagOf(html, 'data-plan-day-button');
      const remove = tagOf(html, 'data-plan-compose-remove');
      for (const tag of [day, remove]) {
        expect(tag).toContain('h-11');
        expect(tag).toContain('rounded-lg');
        expect(tag).not.toMatch(OLD);
      }
      expect(remove).toContain('w-11');
      expect(remove).toContain(`aria-label="Remove ${item.title}"`);
      expect(day).toContain('!justify-between');
    });
  }

  it('a flagged post keeps the warn colours on the day button', () => {
    const html = renderToStaticMarkup(
      <ComposeItemRow item={P} onDay={noop} onEdit={noop} onRemove={noop} />,
    );
    const day = tagOf(html, 'data-plan-day-button="need"');
    expect(day).toContain('border-warn');
    expect(day).toContain('text-warn');
  });
});
