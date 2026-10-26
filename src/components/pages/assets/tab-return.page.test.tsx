// @vitest-environment jsdom
// Assets tab return, page level: the files this session kept (every page the
// person loaded) and the tab totals paint on the first render at any age, with
// no skeleton, then refresh quietly: the refresh lands only while the page is
// untouched, a failed one keeps the kept view, and the page's own writes (Load
// more, a delete) update the kept list instead of dropping it.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetsPage } from '@/components/pages/AssetsPage';
import { keptAssetsPage, type AssetListItem } from '@/lib/assets';
import { READ_FRESH_MS, resetSessionReads } from '@/lib/session-read';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { showToast, listAssets, assetDelete } = vi.hoisted(() => ({
  showToast: vi.fn<(options: unknown) => string>(() => 'toast-1'),
  listAssets: vi.fn(),
  assetDelete: vi.fn(),
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
vi.mock('@/lib/use-workspace-data-changed', () => ({ useWorkspaceDataChanged: () => {} }));
vi.mock('@/lib/assets', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    listAssetsPage: (...args: unknown[]) => listAssets(...args),
    countAssetTabs: async () => ({
      ok: true,
      data: { all: 2, media: 2, pdf: 0, docs: 0, sheets: 0, links: 0 },
    }),
    getAssetItem: async () => ({ ok: true, data: [] }),
    fetchMemberRole: async () => 'owner',
    findAssetsInUse: async () => ({ ok: true, data: [] }),
  };
});
vi.mock('@srtdio/rpc', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, assetDelete: (...args: unknown[]) => assetDelete(...args) };
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

function asset(id: string, filename: string, uploadedAt: string): AssetListItem {
  return {
    id,
    filename,
    displayName: null,
    folderPath: '/',
    folderId: null,
    tags: [],
    uploadedAt,
    currentVersionId: `v-${id}`,
    kind: 'image',
    mimeType: 'image/png',
    sizeBytes: 1024,
    width: null,
    height: null,
    durationMs: null,
    pageCount: null,
    externalUrl: null,
    r2Key: `r2/${id}`,
    versionNumber: 1,
    attachmentCount: 0,
  };
}

const ONE = asset('a1', 'one.png', '2026-10-02T00:00:00Z');
const TWO = asset('a2', 'two.png', '2026-10-01T00:00:00Z');
const NEW = asset('a3', 'new.png', '2026-10-03T00:00:00Z');

let root: Root | null = null;
const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const text = () => document.body.textContent ?? '';
const skeleton = () => document.querySelector('.animate-pulse');
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === label,
  );

function holdNextRead(): (value: unknown) => void {
  let land: (value: unknown) => void = () => {};
  listAssets.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        land = resolve;
      }),
  );
  return (value) => land(value);
}

async function visit(): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <MemoryRouter initialEntries={['/assets']}>
        <AssetsPage />
      </MemoryRouter>,
    );
  });
  await flush();
}

function leave(): void {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-26T10:00:00Z'));
  resetSessionReads();
  showToast.mockClear();
  listAssets.mockReset();
  assetDelete.mockReset();
});

afterEach(() => {
  leave();
  vi.useRealTimers();
  resetSessionReads();
});

describe('Assets tab return', () => {
  it('past the window: the kept files paint at once, then the quiet refresh lands', async () => {
    listAssets.mockResolvedValue({ ok: true, data: { items: [ONE], next: { done: true } } });
    await visit();
    leave();
    vi.setSystemTime(Date.now() + READ_FRESH_MS + 1_000);
    const land = holdNextRead();
    await visit();
    expect(skeleton()).toBeNull();
    expect(text()).toContain('one.png');
    await act(async () => land({ ok: true, data: { items: [NEW, ONE], next: { done: true } } }));
    await flush();
    expect(text()).toContain('new.png');
    expect(listAssets).toHaveBeenCalledTimes(2);
  });

  it('a refresh that lands after a touch is held for the next visit', async () => {
    listAssets.mockResolvedValue({ ok: true, data: { items: [ONE], next: { done: true } } });
    await visit();
    leave();
    vi.setSystemTime(Date.now() + READ_FRESH_MS + 1_000);
    const land = holdNextRead();
    await visit();
    act(() => {
      window.dispatchEvent(new Event('pointerdown'));
    });
    await act(async () => land({ ok: true, data: { items: [NEW, ONE], next: { done: true } } }));
    await flush();
    expect(text()).not.toContain('new.png');
    expect(keptAssetsPage('u1', 'w1')?.items.map((item) => item.id)).toEqual(['a3', 'a1']);
    leave();
    await visit();
    expect(text()).toContain('new.png');
  });

  it('a failed quiet refresh keeps the kept files, with no load error', async () => {
    listAssets.mockResolvedValue({ ok: true, data: { items: [ONE], next: { done: true } } });
    await visit();
    leave();
    vi.setSystemTime(Date.now() + READ_FRESH_MS + 1_000);
    listAssets.mockResolvedValue({ ok: false, error: { code: 'unknown', message: 'boom' } });
    await visit();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(text()).toContain('one.png');
  });

  it('Load more keeps every loaded page, so a return paints them all', async () => {
    const cursor = { uploadedAt: ONE.uploadedAt, id: 'a1' };
    listAssets
      .mockResolvedValueOnce({ ok: true, data: { items: [ONE], next: { done: false, cursor } } })
      .mockResolvedValueOnce({ ok: true, data: { items: [TWO], next: { done: true } } });
    await visit();
    await act(async () => button('Load more')?.click());
    await flush();
    expect(keptAssetsPage('u1', 'w1')?.items.map((item) => item.id)).toEqual(['a1', 'a2']);
    leave();
    await visit();
    expect(skeleton()).toBeNull();
    expect(text()).toContain('one.png');
    expect(text()).toContain('two.png');
    expect(button('Load more')).toBeUndefined();
  });

  it('a delete updates the kept files, never drops them', async () => {
    listAssets.mockResolvedValue({ ok: true, data: { items: [ONE, TWO], next: { done: true } } });
    assetDelete.mockResolvedValue({ ok: true, data: null });
    await visit();
    await act(async () =>
      document.querySelector<HTMLElement>('[aria-label="Select two.png"]')?.click(),
    );
    await act(async () => button('Delete')?.click());
    const undo = showToast.mock.calls.find(
      ([options]) => (options as { onExpire?: () => void }).onExpire !== undefined,
    )?.[0] as { onExpire?: () => void };
    await act(async () => undo.onExpire?.());
    await flush();
    expect(assetDelete).toHaveBeenCalledTimes(1);
    expect(keptAssetsPage('u1', 'w1')?.items.map((item) => item.id)).toEqual(['a1']);
    leave();
    listAssets.mockResolvedValue({ ok: true, data: { items: [ONE], next: { done: true } } });
    await visit();
    expect(skeleton()).toBeNull();
    expect(text()).toContain('one.png');
    expect(text()).not.toContain('two.png');
  });
});
