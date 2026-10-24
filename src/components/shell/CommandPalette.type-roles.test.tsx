// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-router-dom', () => ({ useNavigate: () => () => {} }));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  PaletteBody,
  RECENT_LABEL,
  type PaletteItem,
  type PaletteSection,
} from '@/components/shell/CommandPalette';
import { IDLE_PALETTE_SEARCH } from '@/lib/search/workspace-search';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

const RECENT: PaletteItem = {
  id: 'recent-1',
  type: 'recent',
  title: 'Diwali launch reel',
  typeLabel: 'Post',
  target: { path: '/posts/GBL-1' },
};

const SECTIONS: PaletteSection[] = [{ label: RECENT_LABEL, items: [RECENT] }];

async function mount(): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <PaletteBody
        query=""
        search={IDLE_PALETTE_SEARCH}
        sections={SECTIONS}
        active={-1}
        onHover={() => {}}
        onPick={() => {}}
        onRetry={() => {}}
      />,
    );
  });
}

function classesOf(text: string): string[] {
  const el = [...document.querySelectorAll<HTMLElement>('body *')].find(
    (node) => node.textContent === text && node.children.length === 0,
  );
  if (el === undefined) throw new Error(`no element with text ${text}`);
  return el.className.split(/\s+/);
}

describe('CommandPalette type roles', () => {
  it('the group heading is the section label', async () => {
    await mount();
    const label = classesOf(RECENT_LABEL);
    for (const want of ['text-sm', 'font-semibold', 'uppercase', 'tracking-[0.06em]', 'text-fg-2']) {
      expect(label).toContain(want);
    }
    expect(label).not.toContain('tracking-wide');
    expect(label).not.toContain('text-xs');
    expect(label).not.toContain('text-fg-3');
  });

  it('a row title is the card title and its type is meta', async () => {
    await mount();
    const title = classesOf('Diwali launch reel');
    expect(title).toContain('font-medium');
    expect(title).toContain('text-fg');
    // The row carries text-base for its title.
    const row = document.querySelector('[data-palette-item="recent-1"]');
    expect((row?.className ?? '').split(/\s+/)).toContain('text-base');

    const meta = classesOf('Post');
    expect(meta).toContain('text-sm');
    expect(meta).toContain('text-fg-3');
  });
});
