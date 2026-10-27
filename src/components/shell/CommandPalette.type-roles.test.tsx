// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-router-dom', () => ({ useNavigate: () => () => {} }));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/components/ui/toast', () => ({
  useToast: () => ({ show: () => 'toast-1', dismiss: () => {} }),
}));

import { supabase } from '@/lib/supabase';
import { readRecents, recentKey, resetRecentsRefresh } from '@/lib/recent-items';
import {
  CommandPalette,
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
  window.localStorage.clear();
  vi.useRealTimers();
});

const RECENT: PaletteItem = {
  id: 'recent-1',
  type: 'recent',
  title: 'Diwali launch reel',
  typeLabel: 'Post',
  target: { path: '/posts/GBL-1' },
  recent: { type: 'post', id: 'p1' },
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
    for (const want of [
      'text-sm',
      'font-semibold',
      'uppercase',
      'tracking-[0.06em]',
      'text-fg-2',
    ]) {
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

const WS = '0190a000-0000-7000-8000-00000000a001';
const ME = '0190a000-0000-7000-8000-0000000000a4';

/** The client's from(): each table's rows by .in() id, or a read that never lands. */
function stubFrom(tables: Record<string, Array<Record<string, unknown>>> | 'hang'): string[] {
  const calls: string[] = [];
  (supabase as unknown as { from: unknown }).from = (table: string) => {
    let ids: string[] = [];
    const chain = {
      select: () => chain,
      eq: () => chain,
      is: () => chain,
      in: (_col: string, values: string[]) => {
        ids = values;
        calls.push(table);
        return chain;
      },
      then: (resolve: (v: unknown) => void) => {
        if (tables === 'hang') return;
        resolve({
          data: (tables[table] ?? []).filter((r) => ids.includes(String(r.id))),
          error: null,
        });
      },
    };
    return chain;
  };
  return calls;
}

async function mountPalette(): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <CommandPalette open onClose={() => {}} workspaceId={WS} workspaceKey="GBL" userId={ME} />,
    );
  });
}

const rowTitles = (): string[] =>
  [...document.querySelectorAll('[data-palette-item] .font-medium')].map(
    (el) => el.textContent ?? '',
  );

describe('CommandPalette Recent paint', () => {
  it('the session refresh writes storage only: rows on screen are not repainted', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    resetRecentsRefresh();
    window.localStorage.setItem(
      recentKey(ME, WS),
      JSON.stringify([
        { type: 'post', id: 'p1', openedAt: 1, title: 'Old title', target: { path: '/p/gbl-1' } },
      ]),
    );
    const calls = stubFrom({ posts: [{ id: 'p1', title: 'New title', number: 1 }] });
    await mountPalette();
    expect(rowTitles()).toEqual(['Old title']);
    expect(calls).toEqual([]);
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    await act(async () => {
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    });
    expect(calls).toEqual(['posts']);
    expect(readRecents(window.localStorage, ME, WS)[0]?.title).toBe('New title');
    expect(rowTitles()).toEqual(['Old title']);
  });

  it('an uncached row: cached rows paint at once; past the 600 ms ceiling it stays out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    window.localStorage.setItem(
      recentKey(ME, WS),
      JSON.stringify([
        { type: 'post', id: 'p-new', openedAt: 2 },
        { type: 'post', id: 'p1', openedAt: 1, title: 'Cached', target: { path: '/p/gbl-1' } },
      ]),
    );
    stubFrom('hang');
    await mountPalette();
    expect(rowTitles()).toEqual(['Cached']);
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(rowTitles()).toEqual(['Cached']);
  });

  it('an uncached row joins once its batched read lands inside the ceiling', async () => {
    window.localStorage.setItem(
      recentKey(ME, WS),
      JSON.stringify([
        { type: 'post', id: 'p-new', openedAt: 2 },
        { type: 'post', id: 'p1', openedAt: 1, title: 'Cached', target: { path: '/p/gbl-1' } },
      ]),
    );
    stubFrom({ posts: [{ id: 'p-new', title: 'Fresh', number: 2 }] });
    await mountPalette();
    await act(async () => {
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    });
    expect(rowTitles()).toEqual(['Fresh', 'Cached']);
    expect(readRecents(window.localStorage, ME, WS)[0]?.title).toBe('Fresh');
  });
});
