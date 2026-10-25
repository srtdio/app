import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Desktop layout: the trigger renders inline (the menu stays closed).
vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => true,
}));

import { SortMenu, sortOptionButtons, type SortOption } from '@/components/ui/SortMenu';
import { Toast } from '@/components/ui/toast/Toast';

// Button system regression for the overlay controls this group owns: the sort
// trigger (was h-9 on desktop, rounded-md), the sort rows (were md:h-9), and the
// toast action / dismiss (were rounded-md, font-semibold).

const options: SortOption<'recent' | 'name'>[] = [
  { value: 'recent', label: 'Recent' },
  { value: 'name', label: 'Name' },
];

function classOf(el: ReactElement): string[] {
  return ((el.props as { className?: string }).className ?? '').split(/\s+/).filter(Boolean);
}

const BAD = ['h-9', 'md:h-9', 'h-12', 'rounded-md', 'rounded-xl', 'font-semibold', 'text-sm'];

describe('SortMenu buttons', () => {
  it('the trigger is one 44px, 8px-radius IconButton labelled Sort, no chevron', () => {
    const html = renderToStaticMarkup(
      <SortMenu options={options} value="recent" onChange={() => {}} />,
    );
    const trigger = /<button[^>]*aria-haspopup="menu"[^>]*>/.exec(html)?.[0] ?? '';
    expect(trigger).toContain('h-11');
    expect(trigger).toContain('w-11');
    expect(trigger).toContain('rounded-lg');
    expect(trigger).toContain('aria-label="Sort"');
    // One sort icon only: no label text, no dropdown chevron.
    const body = /aria-haspopup="menu"[^>]*>([\s\S]*?)<\/button>/.exec(html)?.[1] ?? '';
    expect(body.match(/<svg/g)).toHaveLength(1);
    expect(body).not.toContain('Recent');
    for (const bad of BAD) expect(trigger.split(/[\s"]/)).not.toContain(bad);
  });

  it('every option row keeps a 44px target with the 8px radius', () => {
    for (const row of sortOptionButtons(options, 'name', () => {})) {
      const t = classOf(row);
      expect(t).toContain('min-h-[44px]');
      expect(t).toContain('rounded-lg');
      for (const bad of BAD) expect(t).not.toContain(bad);
    }
  });
});

function isElement(node: ReactNode): node is ReactElement {
  return typeof node === 'object' && node !== null && 'props' in node;
}

function rawButtons(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    node.forEach((child) => rawButtons(child, out));
    return out;
  }
  if (!isElement(node)) return out;
  if (node.type === 'button') out.push(node);
  rawButtons((node.props as { children?: ReactNode }).children, out);
  return out;
}

describe('Toast buttons', () => {
  it('the action and dismiss are 44 tall, 8px radius, 14 / 500', () => {
    const tree = Toast({
      toast: { id: '1', title: 'Saved', action: { label: 'Undo', onPress: () => {} } },
      onDismiss: () => {},
    });
    const found = rawButtons(tree);
    const action = found.find(
      (el) => (el.props as Record<string, unknown>)['data-toast-action'] === '',
    );
    const dismiss = found.find(
      (el) => (el.props as Record<string, unknown>)['aria-label'] === 'Dismiss notification',
    );
    expect(action).toBeDefined();
    expect(dismiss).toBeDefined();
    for (const el of [action!, dismiss!]) {
      const t = classOf(el);
      expect(t).toContain('h-11');
      expect(t).toContain('rounded-lg');
      for (const bad of BAD) expect(t).not.toContain(bad);
    }
    expect(classOf(action!)).toContain('text-base');
    expect(classOf(action!)).toContain('font-medium');
  });
});
