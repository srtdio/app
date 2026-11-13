// @vitest-environment jsdom
// Catch up per tab (13 Nov 2026): Activity has NO catch-up rows (no Catch up,
// no Threads solid row, no Threads list) and never opens a card stack; its
// chips All, Unread, Mentions stay. Each list tab shows its own rows above
// its chip row (catch-up/TabCatchUp, ListScreen's catchUp slot), only while a
// count is above 0. Guard for both.
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { TopbarActionsProvider, useTopbarActions } from '@/components/shell/topbar-actions';
import { ListScreen } from '@/components/shell/ListScreen';
import { TopbarSlots } from '@/components/shell/Topbar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

async function mount(node: ReactElement): Promise<void> {
  if (root === null) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  }
  await act(async () => {
    root?.render(node);
  });
}

// jsdom: import.meta.url is not a file URL; vitest runs from the repo root.
const read = (path: string): string => readFileSync(join(process.cwd(), path), 'utf8');

describe('guard: Activity has no catch-up rows and no card stack', () => {
  const page = read('src/components/pages/NotificationsPage.tsx');
  const bar = read('src/components/shell/topbar-actions.tsx');
  it('topbar-actions no longer builds the Catch up or Threads solid rows', () => {
    expect(bar).not.toMatch(/ActivitySolidRows|useActivitySolidRows|data-topbar-catch-up/);
    expect(bar).not.toMatch(/data-topbar-threads|MARK_ALL_AS_READ|<ListCard\b/);
  });
  it('Activity mounts no lead row, no CatchUpScreen and no Threads list', () => {
    expect(page).not.toMatch(/lead=\{/);
    expect(page).not.toMatch(/<CatchUpScreen\b|<ThreadsListScreen\b|useTabCatchUp/);
    expect(
      existsSync(join(process.cwd(), 'src/components/pages/activity/ThreadsListScreen.tsx')),
    ).toBe(false);
  });
  it('old links redirect to the tabs (oldCatchUpTarget), never a stack on Activity', () => {
    expect(page).toContain('oldCatchUpTarget(');
  });
  it('the chips stay: ActivityFilterBar renders All, Unread, Mentions', () => {
    expect(page).toContain('<ActivityFilterBar');
    const chips = read('src/components/pages/activity/ActivityFilterBar.tsx');
    for (const word of ["'All'", "'Unread'", "'Mentions'"]) expect(chips).toContain(word);
  });
});

describe('ListScreen: the catch-up strip sits above the chips, only with rows', () => {
  it('no rows: no strip, nothing reserved', async () => {
    await mount(
      <ListScreen title="Pipeline" chips={<span data-chip="" />} catchUp={null}>
        <span />
      </ListScreen>,
    );
    expect(document.querySelector('[data-shell="catch-up"]')).toBeNull();
  });
  it('rows: the strip comes before the chip row', async () => {
    await mount(
      <ListScreen title="Pipeline" chips={<span data-chip="" />} catchUp={<div data-rows="" />}>
        <span />
      </ListScreen>,
    );
    const strip = document.querySelector('[data-shell="catch-up"]');
    const chips = document.querySelector('[data-shell="chips"]');
    expect(strip?.querySelector('[data-rows]')).not.toBeNull();
    expect(
      strip !== null &&
        chips !== null &&
        (strip.compareDocumentPosition(chips) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    ).toBe(true);
  });
});

describe('Topbar: the same two slots on every tab (Activity publishes none)', () => {
  function Publish() {
    useTopbarActions({});
    return null;
  }
  it('nothing published: the two fixed slots stay as empty boxes, no pair', async () => {
    await mount(
      <TopbarActionsProvider>
        <TopbarSlots />
        <Publish />
      </TopbarActionsProvider>,
    );
    expect(
      [...document.querySelectorAll('[data-topbar-slot]')].map((s) =>
        s.getAttribute('data-topbar-slot'),
      ),
    ).toEqual(['sort', 'primary']);
    expect(document.querySelector('[data-topbar-pair]')).toBeNull();
  });
});
