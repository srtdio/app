import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';

// Button system regression: every control in the top bar is 44 tall with the
// 8px radius. Topbar holds no hooks, so it is called as a function and its tree
// walked; Button / IconButton are hookless, so they are expanded the same way to
// read the class string they render.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { Topbar } from '@/components/shell/Topbar';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';

function isElement(node: ReactNode): node is ReactElement {
  return typeof node === 'object' && node !== null && 'props' in node;
}

/** Every <button> the tree renders, with Button / IconButton expanded. */
function buttons(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    node.forEach((child) => buttons(child, out));
    return out;
  }
  if (!isElement(node)) return out;
  if (node.type === Button) {
    return buttons(Button(node.props as Parameters<typeof Button>[0]), out);
  }
  if (node.type === IconButton) {
    return buttons(IconButton(node.props as Parameters<typeof IconButton>[0]), out);
  }
  if (node.type === 'button') out.push(node);
  buttons((node.props as { children?: ReactNode }).children, out);
  return out;
}

function tokens(el: ReactElement): string[] {
  return ((el.props as { className?: string }).className ?? '').split(/\s+/).filter(Boolean);
}

const BAD = ['h-8', 'h-9', 'h-10', 'h-12', 'rounded-md', 'rounded-xl', 'font-semibold', 'text-sm'];

function expectSystem(el: ReactElement): void {
  const t = tokens(el);
  expect(t).toContain('h-11');
  expect(t).toContain('rounded-lg');
  for (const bad of BAD) expect(t).not.toContain(bad);
  expect(t.some((c) => /^text-\[\d+px\]$/.test(c))).toBe(false);
}

const base = { onOpenPalette: () => {}, onOpenAvatar: () => {} };

describe('Topbar buttons follow the design system', () => {
  it('workspace switcher, desktop search, phone search and account menu', () => {
    const found = buttons(Topbar({ ...base, workspaceName: 'Acme' }));
    // Switcher, search trigger, phone search, account menu (Notifications is its own component).
    expect(found.length).toBeGreaterThanOrEqual(4);
    for (const el of found) expectSystem(el);
  });

  it('the desktop search trigger is 44 tall (was h-9)', () => {
    const found = buttons(Topbar({ ...base, workspaceName: 'Acme' }));
    const search = found.find((el) => tokens(el).includes('min-w-[240px]'));
    expect(search).toBeDefined();
    expect(tokens(search!)).toContain('h-11');
    expect(tokens(search!)).not.toContain('h-9');
  });

  it('the create-workspace slot uses the shared recipe', () => {
    const found = buttons(Topbar({ ...base, workspaceName: null, onCreateWorkspace: () => {} }));
    expect(found.length).toBeGreaterThan(0);
    for (const el of found) expectSystem(el);
  });
});
