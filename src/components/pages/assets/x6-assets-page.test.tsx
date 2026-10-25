// @vitest-environment jsdom
// X6 Assets page regressions, rendered for real in jsdom with the data reads
// mocked: a failed files read is a page load error (never a partial grid),
// ?asset= for a gone file says so, the header offers a "New asset" menu, and the
// page has no folder UI at all.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetsPage } from '@/components/pages/AssetsPage';
import type { AssetListItem } from '@/lib/assets';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { showToast, listAssets, findAssetsInUse, assetDelete, assetDeleteMany } = vi.hoisted(() => ({
  showToast: vi.fn<(options: unknown) => string>(() => 'toast-1'),
  listAssets: vi.fn(),
  findAssetsInUse: vi.fn(),
  assetDelete: vi.fn(),
  assetDeleteMany: vi.fn(),
}));

vi.mock('@/lib/env', () => ({ env: { VITE_ASSET_UPLOAD_URL: 'https://upload.test' } }));
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { access_token: 'token' } } }) },
  },
}));
vi.mock('@/lib/workspace-context', () => ({ useWorkspace: () => ({ workspaceId: 'w1' }) }));
vi.mock('@/lib/session-context', () => ({
  useSession: () => ({ session: { user: { id: 'u1' } } }),
}));
vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => () => 'trace-1' }));
vi.mock('@/components/ui/toast', () => ({
  useOptionalToast: () => ({ show: showToast, dismiss: vi.fn() }),
}));
vi.mock('@/lib/assets', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    listAssets: (...args: unknown[]) => listAssets(...args),
    fetchMemberRole: async () => 'owner',
    findAssetsInUse: (...args: unknown[]) => findAssetsInUse(...args),
  };
});
vi.mock('@srtdio/rpc', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    assetDelete: (...args: unknown[]) => assetDelete(...args),
    assetDeleteMany: (...args: unknown[]) => assetDeleteMany(...args),
  };
});
// SortMenu reads a media query; jsdom has no matchMedia.
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

function asset(overrides: Partial<AssetListItem> = {}): AssetListItem {
  return {
    id: 'a1',
    filename: 'inside-brand.png',
    displayName: null,
    folderPath: '/',
    folderId: 'f1',
    tags: [],
    uploadedAt: '2026-10-01T00:00:00Z',
    currentVersionId: 'v1',
    kind: 'image',
    mimeType: 'image/png',
    sizeBytes: 1024,
    width: null,
    height: null,
    durationMs: null,
    pageCount: null,
    externalUrl: null,
    r2Key: 'r2/a1',
    versionNumber: 1,
    attachmentCount: 0,
    ...overrides,
  };
}

let root: Root | null = null;
const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

async function mount(path = '/assets'): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <MemoryRouter initialEntries={[path]}>
        <AssetsPage />
      </MemoryRouter>,
    );
  });
  await flush();
}

const text = () => document.body.textContent ?? '';
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === label,
  );

beforeEach(() => {
  showToast.mockClear();
  listAssets.mockReset();
  findAssetsInUse.mockReset();
  assetDelete.mockReset();
  assetDeleteMany.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('X6 files read failure', () => {
  it('a files read failure is LoadError too, never the raw error text', async () => {
    listAssets.mockResolvedValue({ ok: false, error: { message: 'permission denied for table' } });
    await mount();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn't load your files.",
    );
    expect(text()).not.toContain('permission denied');
    expect(text()).not.toContain('Files show up here.');
  });
});

describe('X6 ?asset= for a deleted or unknown file', () => {
  it('toasts "This file was deleted." with a Recently deleted action, on an empty library too', async () => {
    listAssets.mockResolvedValue({ ok: true, data: [] });
    await mount('/assets?asset=gone-1');
    const call = showToast.mock.calls.find(
      ([options]) => (options as { title?: string }).title === 'This file was deleted.',
    );
    expect(call).toBeDefined();
    expect((call?.[0] as { action?: { label: string } }).action?.label).toBe('Recently deleted');
  });
});

describe('X6 Recently deleted link', () => {
  it('the Assets page links to Recently deleted', async () => {
    listAssets.mockResolvedValue({ ok: true, data: [asset({ folderId: null })] });
    await mount();
    expect(document.querySelector('[data-recently-deleted-link]')?.textContent).toBe(
      'Recently deleted',
    );
  });
});

describe('X6 bulk delete keeps the files in use', () => {
  it('checks once, deletes only the free files in one call, and says how many were kept', async () => {
    listAssets.mockResolvedValue({
      ok: true,
      data: [
        asset({ id: 'a1', filename: 'one.png', folderId: null }),
        asset({ id: 'a2', filename: 'two.png', folderId: null }),
        asset({ id: 'a3', filename: 'three.png', folderId: null }),
      ],
    });
    findAssetsInUse.mockResolvedValue({
      ok: true,
      data: [{ assetId: 'a1', parent: { kind: 'post', href: '/posts/p1' } }],
    });
    assetDeleteMany.mockResolvedValue({ ok: true, data: null });
    await mount();

    for (const name of ['one.png', 'two.png', 'three.png']) {
      await act(async () =>
        document.querySelector<HTMLElement>(`[aria-label="Select ${name}"]`)?.click(),
      );
    }
    await act(async () => button('Delete')?.click());

    const undo = showToast.mock.calls.find(
      ([options]) =>
        (options as { title?: string }).title ===
        '3 files deleted. Undo or find them in Recently deleted.',
    )?.[0] as { onExpire?: () => void };
    expect(undo).toBeDefined();
    await act(async () => undo.onExpire?.());
    await flush();

    expect(findAssetsInUse).toHaveBeenCalledTimes(1);
    expect(assetDelete).not.toHaveBeenCalled();
    expect(assetDeleteMany).toHaveBeenCalledTimes(1);
    expect(assetDeleteMany.mock.calls[0]?.[1]).toMatchObject({ p_asset_ids: ['a2', 'a3'] });
    expect(
      showToast.mock.calls.some(
        ([options]) => (options as { title?: string }).title === '1 file is in use and was kept.',
      ),
    ).toBe(true);
    expect(text()).toContain('one.png');
    expect(text()).not.toContain('two.png');
  });
});

describe('Assets header "New asset" menu', () => {
  it('is a visible "New asset" text button that opens Upload files and Add link', async () => {
    listAssets.mockResolvedValue({ ok: true, data: [asset({ folderId: null })] });
    await mount();

    const trigger = button('New asset');
    expect(trigger).toBeDefined();
    expect(trigger?.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    expect(trigger?.hasAttribute('aria-label')).toBe(false);
    // IconPlus before the label, like every New button.
    expect(trigger?.querySelector('svg')).not.toBeNull();
    expect(document.querySelector('[aria-label="Add asset"]')).toBeNull();

    await act(async () => trigger?.click());
    await flush();

    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
    const items = [...document.querySelectorAll('[role="menuitem"]')].map((el) =>
      el.textContent?.trim(),
    );
    expect(items).toEqual(['Upload files', 'Add link']);
  });
});

describe('Assets has no folders', () => {
  it('shows every file, ignores ?folder=, and renders no Folders breadcrumb', async () => {
    listAssets.mockResolvedValue({
      ok: true,
      data: [
        asset({ id: 'a1', filename: 'inside-brand.png', folderId: 'f1' }),
        asset({ id: 'a2', filename: 'at-root.png', folderId: null }),
      ],
    });
    await mount('/assets?folder=f1');

    expect(text()).toContain('inside-brand.png');
    expect(text()).toContain('at-root.png');
    expect(document.querySelector('nav[aria-label="Folders"]')).toBeNull();
    expect(text()).not.toContain('No files in this folder yet');
    expect(text()).not.toContain('New folder');
  });

  it('the select bar offers Delete and no Move', async () => {
    listAssets.mockResolvedValue({
      ok: true,
      data: [asset({ id: 'a1', filename: 'one.png', folderId: null })],
    });
    await mount();

    await act(async () =>
      document.querySelector<HTMLElement>('[aria-label="Select one.png"]')?.click(),
    );

    expect(button('Delete')).toBeDefined();
    expect(button('Move')).toBeUndefined();
    const labels = [...document.querySelectorAll('button')].map((b) => b.textContent ?? '');
    expect(labels.some((label) => label.includes('Move'))).toBe(false);
  });
});
