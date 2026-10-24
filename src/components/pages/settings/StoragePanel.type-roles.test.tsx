// @vitest-environment jsdom
// Type roles on Settings > Storage (design rules, 24 Oct 2026): the storage
// figure is 3xl/600 (never bold), "of 1 GB" and the workspace line are sm fg-3
// meta, WHAT'S USING IT and NEED MORE SPACE? are section labels (sm/600
// uppercase tracking-[0.06em] fg-2), a usage row is base, and the need-more
// line is base fg-2 copy. Mocks mirror StoragePanel.test.tsx.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockStorage } = vi.hoisted(() => ({ mockStorage: vi.fn() }));

vi.mock('@srtdio/rpc', () => ({ workspaceStorage: mockStorage }));
vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: 'ws-1', workspaceDisplayName: 'Acme - LinkedIn' }),
}));
vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => () => 'trace-1' }));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/env', () => ({
  env: { VITE_SUPABASE_URL: 'https://sb.test', VITE_SUPABASE_PUBLISHABLE_KEY: 'pk' },
}));

import type { StorageUsage } from '@/components/storage/storage-usage';
import { StoragePanel } from './StoragePanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MB = 1024 * 1024;
const WARN = 800 * MB;
let root: Root | null = null;

function usage(usedBytes: number): StorageUsage {
  return { usedBytes, warnAtBytes: WARN, warn: usedBytes >= WARN, exempt: false };
}

function storageRow(usedBytes: number) {
  return {
    ok: true,
    data: [
      {
        bytes_used: usedBytes,
        library_bytes: 500 * MB,
        chat_bytes: 120 * MB,
        voice_bytes: 30 * MB,
        deleted_bytes: 64 * MB,
      },
    ],
  };
}

async function render(value: StorageUsage): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <MemoryRouter>
        <StoragePanel usage={value} />
      </MemoryRouter>,
    ),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** The deepest element whose whole text is `text`. */
function byText(text: string): HTMLElement {
  const hits = [...document.body.querySelectorAll<HTMLElement>('*')].filter(
    (el) => el.textContent?.trim() === text,
  );
  const deepest = hits.find((el) => ![...el.children].some((c) => c.textContent?.trim() === text));
  if (deepest === undefined) throw new Error(`no element with text "${text}"`);
  return deepest;
}

function expectRole(el: Element, classes: string[]): void {
  const list = el.className.split(/\s+/);
  for (const c of classes) expect(list).toContain(c);
}

const SECTION_LABEL = ['text-sm', 'font-semibold', 'uppercase', 'tracking-[0.06em]', 'text-fg-2'];

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  mockStorage.mockReset();
});

describe('StoragePanel type roles', () => {
  it('the storage figure is 3xl/600, never bold', async () => {
    mockStorage.mockResolvedValue(storageRow(700 * MB));
    await render(usage(700 * MB));
    const figure = byText('700 MB');
    expectRole(figure, ['text-3xl', 'font-semibold', 'tabular-nums']);
    expect(figure.className).not.toContain('font-bold');
  });

  it('"of 1 GB" and the workspace line are sm fg-3 meta', async () => {
    mockStorage.mockResolvedValue(storageRow(700 * MB));
    await render(usage(700 * MB));
    expectRole(byText('of 1 GB'), ['text-sm', 'text-fg-3']);
    expectRole(byText('Acme - LinkedIn · everything in this workspace counts'), [
      'text-sm',
      'text-fg-3',
    ]);
  });

  it("WHAT'S USING IT is a section label over base usage rows", async () => {
    mockStorage.mockResolvedValue(storageRow(700 * MB));
    await render(usage(700 * MB));
    const label = byText("WHAT'S USING IT");
    expect(label.tagName).toBe('H3');
    expectRole(label, SECTION_LABEL);
    const row = byText('Assets').parentElement as HTMLElement;
    expectRole(row, ['text-base']);
  });

  it('NEED MORE SPACE? is a section label over base fg-2 copy', async () => {
    mockStorage.mockResolvedValue(storageRow(820 * MB));
    await render(usage(820 * MB));
    expectRole(byText('NEED MORE SPACE?'), SECTION_LABEL);
    const copy = byText(
      'Free up space in Recently deleted, or talk to us about more storage for Acme - LinkedIn.',
    );
    expectRole(copy, ['text-base', 'text-fg-2']);
    expect(copy.className).not.toContain('text-md');
  });
});
