import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { renderToStaticMarkup } from 'react-dom/server';
import { ConceptDateField, RenameField } from '@/components/chat/PlanScreen';

const noop = (): void => undefined;
const OLD = /\bh-8\b|\bh-9\b|\bh-10\b|\bh-12\b|rounded-md|rounded-xl|font-semibold|text-\[15px\]/;
const dir = fileURLToPath(new URL('.', import.meta.url));
const read = (name: string): string => readFileSync(`${dir}${name}`, 'utf8');

function buttonTags(html: string): string[] {
  return html.match(/<button[^>]*>/g) ?? [];
}

describe('Plan screen buttons (design system)', () => {
  it('rename: Cancel (X) and Done are 44px with the 8px radius', () => {
    const html = renderToStaticMarkup(
      <RenameField value="Week" busy={false} onChange={noop} onCancel={noop} onDone={noop} />,
    );
    const tags = buttonTags(html);
    expect(tags).toHaveLength(2);
    for (const tag of tags) {
      expect(tag).toContain('h-11');
      expect(tag).toContain('rounded-lg');
      expect(tag).not.toMatch(OLD);
    }
    expect(tags.find((t) => t.includes('data-plan-rename-done'))).toContain('text-accent');
    // The field: 44px, 8px radius, panel-2.
    expect(html).toMatch(/<input[^>]*class="[^"]*h-11[^"]*rounded-lg[^"]*bg-panel-2/);
  });

  it('the date clear is the 44x44 icon button', () => {
    const html = renderToStaticMarkup(<ConceptDateField value="2026-10-14" onChange={noop} />);
    const [tag = ''] = buttonTags(html);
    expect(tag).toContain('aria-label="Clear date"');
    expect(tag).toContain('h-11 w-11');
    expect(tag).toContain('rounded-lg');
    expect(tag).not.toContain('rounded-full');
  });

  it('item, compose and card sources carry no old button recipes', () => {
    const item = read('PlanItemScreen.tsx');
    expect(item).not.toContain('rounded-full border px-3 text-md font-medium');
    expect(item).not.toContain('rounded-md px-2 text-lg font-medium text-accent');
    expect(item).toMatch(/variant="success"\s+data-plan-approve=""/);
    expect(item).toMatch(/shape="round"[\s\S]*?data-plan-comment-send=/);
    const compose = read('PlanComposeScreen.tsx');
    expect(compose).not.toContain('rounded-xl border border-dashed');
    expect(compose).not.toContain('min-h-[50px]');
    expect(compose).not.toContain('rounded-[10px] text-fg-2');
    const card = read('PlanCard.tsx');
    expect(card).not.toContain('min-h-[48px] flex-1 text-lg font-semibold');
    const screen = read('PlanScreen.tsx');
    expect(screen).not.toContain('size="lg"');
    expect(screen).not.toContain('min-h-[48px] w-full min-w-0');
  });
});
