// @vitest-environment jsdom
// X6 Assets page regressions, rendered for real in jsdom with the data reads
// mocked: a failed folders or files read is a page load error (never a partial
// grid), ?asset= for a gone file says so, and a folder delete waits behind Undo.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetsPage } from '@/components/pages/AssetsPage';
import type { AssetListItem, FolderItem } from '@/lib/assets';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const {
  showToast,
  listAssets,
  fetchFolders,
  deleteFolderRequest,
  findAssetsInUse,
  assetDelete,
  assetDeleteMany,
} = vi.hoisted(() => ({
  showToast: vi.fn<(options: unknown) => string>(() => 'toast-1'),
  listAssets: vi.fn(),
  fetchFolders: vi.fn(),
  deleteFolderRequest: vi.fn(),
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
    fetchFolders: (...args: unknown[]) => fetchFolders(...args),
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
vi.mock('@/lib/asset-upload', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    deleteFolderRequest: (...args: unknown[]) => deleteFolderRequest(...args),
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

const BRAND: FolderItem = { id: 'f1', name: 'Brand', parentId: null };

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
  fetchFolders.mockReset();
  deleteFolderRequest.mockReset();
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

describe('X6 folders read failure', () => {
  it('shows LoadError, renders no grid, counts or empty folder line, and Retry re-reads both', async () => {
    listAssets.mockResolvedValue({ ok: true, data: [asset()] });
    fetchFolders.mockResolvedValueOnce({ ok: false, error: { message: 'boom' } });
    await mount('/assets?folder=f1');

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn't load your folders.",
    );
    // No partial read: the file in the folder is not shown as if it sat
    // anywhere, there are no tab counts, and nothing claims the folder is empty.
    expect(text()).not.toContain('inside-brand.png');
    expect(document.querySelector('[role="tablist"]')).toBeNull();
    expect(text()).not.toContain('This folder is empty');
    expect(text()).not.toContain('boom');

    fetchFolders.mockResolvedValueOnce({ ok: true, data: [BRAND] });
    const assetReads = listAssets.mock.calls.length;
    await act(async () => button('Retry')?.click());
    await flush();

    expect(listAssets.mock.calls.length).toBe(assetReads + 1);
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(text()).toContain('inside-brand.png');
  });

  it('a files read failure is LoadError too, never the raw error text', async () => {
    listAssets.mockResolvedValue({ ok: false, error: { message: 'permission denied for table' } });
    fetchFolders.mockResolvedValue({ ok: true, data: [] });
    await mount();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn't load your files.",
    );
    expect(text()).not.toContain('permission denied');
    expect(text()).not.toContain('No assets yet');
  });
});

describe('X6 ?asset= for a deleted or unknown file', () => {
  it('toasts "This file was deleted." with a Recently deleted action, on an empty library too', async () => {
    listAssets.mockResolvedValue({ ok: true, data: [] });
    fetchFolders.mockResolvedValue({ ok: true, data: [] });
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
    fetchFolders.mockResolvedValue({ ok: true, data: [] });
    await mount();
    expect(document.querySelector('[data-recently-deleted-link]')?.textContent).toBe(
      'Recently deleted',
    );
  });
});

describe('X6 folder delete behind Undo', () => {
  it('hides the folder, shows "Folder deleted" with Undo, and Undo never calls the worker', async () => {
    listAssets.mockResolvedValue({ ok: true, data: [] });
    fetchFolders.mockResolvedValue({ ok: true, data: [BRAND] });
    await mount();

    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="More actions for Brand"]')?.click(),
    );
    await act(async () => button('Delete folder')?.click());
    expect(text()).toContain('Files inside move to All assets');
    await act(async () => button('Delete')?.click());
    await flush();

    const undoToast = showToast.mock.calls.find(
      ([options]) => (options as { title?: string }).title === 'Folder deleted',
    )?.[0] as { action?: { label: string; onPress: () => void }; durationMs?: number };
    expect(undoToast?.action?.label).toBe('Undo');
    expect(undoToast?.durationMs).toBe(7000);
    expect(document.querySelector('[aria-label="More actions for Brand"]')).toBeNull();

    await act(async () => undoToast?.action?.onPress());
    expect(document.querySelector('[aria-label="More actions for Brand"]')).not.toBeNull();
    expect(deleteFolderRequest).not.toHaveBeenCalled();
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
    fetchFolders.mockResolvedValue({ ok: true, data: [] });
    findAssetsInUse.mockResolvedValue({
      ok: true,
      data: [{ assetId: 'a1', parent: { kind: 'post', href: '/posts/p1' } }],
    });
    assetDeleteMany.mockResolvedValue({ ok: true, data: null });
    await mount();

    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Add asset"]')?.click(),
    );
    await act(async () => button('Select')?.click());
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
