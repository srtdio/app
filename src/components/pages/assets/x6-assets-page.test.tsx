// @vitest-environment jsdom
// X6 Assets page regressions, rendered for real in jsdom with the data reads
// mocked: a failed files read is a page load error (never a partial grid),
// ?asset= for a gone file says so, the top bar carries the page's Sort and its
// "+" (New file menu), the chip row's Select starts select mode, and the page
// has no folder UI and no list search at all.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetsPage } from '@/components/pages/AssetsPage';
import { TopbarActionsProvider, useTopbarActionsValue } from '@/components/shell/topbar-actions';
import { INDUCTION_KEYS } from '@/lib/induction';
import { resetSessionReads } from '@/lib/session-read';
import { resetHistorySteps } from '@/lib/chat/use-history-step';
import type { AssetListItem } from '@/lib/assets';
import { getFillCount } from '@/lib/use-fill-count';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { showToast, listAssets, getAssetItem, findAssetsInUse, assetDelete, assetDeleteMany } =
  vi.hoisted(() => ({
    showToast: vi.fn<(options: unknown) => string>(() => 'toast-1'),
    listAssets: vi.fn(),
    getAssetItem: vi.fn(),
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
    // The page reads keyset pages; a mocked plain list is one (last) page, and a
    // mocked { items, next } page passes through as is.
    listAssetsPage: async (...args: unknown[]) => {
      const result = (await listAssets(...args)) as
        | { ok: true; data: unknown }
        | { ok: false; error: unknown };
      if (!result.ok || !Array.isArray(result.data)) return result;
      return { ok: true, data: { items: result.data, next: { done: true } } };
    },
    getAssetItem: (...args: unknown[]) => getAssetItem(...args),
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

/** Stands in for Topbar: renders what the page published into its two slots. */
function TopbarProbe() {
  const { sort, primary } = useTopbarActionsValue();
  return (
    <div data-test-topbar="">
      <div data-test-topbar-sort="">{sort}</div>
      <div data-test-topbar-primary="">{primary}</div>
    </div>
  );
}

async function mount(path = '/assets'): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <MemoryRouter initialEntries={[path]}>
        <TopbarActionsProvider>
          <TopbarProbe />
          <AssetsPage />
        </TopbarActionsProvider>
      </MemoryRouter>,
    );
  });
  await flush();
}

const text = () => document.body.textContent ?? '';

/** Right-click a card (laptop): select mode starts with that card ticked. */
async function rightClick(assetId: string): Promise<void> {
  await act(async () => {
    document
      .querySelector<HTMLElement>(`[data-asset-card="${assetId}"]`)
      ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  });
  await flush();
}

/** A tap on a card (its whole-card button); in select mode it toggles. */
async function tapCard(name: string): Promise<void> {
  await act(async () =>
    document.querySelector<HTMLElement>(`[aria-label="View ${name}"]`)?.click(),
  );
}

const barAction = (id: string) =>
  document.querySelector<HTMLButtonElement>(`[data-select-bar-action="${id}"]`);
const barActionIds = () =>
  [...document.querySelectorAll<HTMLElement>('[data-select-bar-action]')].map((el) =>
    el.getAttribute('data-select-bar-action'),
  );
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === label,
  );

beforeEach(() => {
  showToast.mockClear();
  listAssets.mockReset();
  getAssetItem.mockReset().mockResolvedValue({ ok: true, data: [] });
  findAssetsInUse.mockReset();
  assetDelete.mockReset();
  assetDeleteMany.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
  // The kept list and tab outlive the page; each test starts a fresh session.
  resetSessionReads();
  // Select mode holds a history entry; each test starts with none.
  resetHistorySteps();
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

  it("is the link variant, its text on the cards' left edge (no double gutter)", async () => {
    listAssets.mockResolvedValue({ ok: true, data: [asset({ folderId: null })] });
    await mount();
    const link = document.querySelector('[data-recently-deleted-link]');
    const cls = (link?.getAttribute('class') ?? '').split(/\s+/);
    // The shared link variant (a Tool: fg text, its own 8px side padding), 44 tall.
    expect(cls).toContain('text-fg');
    expect(cls).toContain('h-11');
    expect(cls).not.toContain('text-fg-2');
    // No duplicate call-site focus ring; the primitive carries it.
    expect(cls.filter((c) => c === 'focus-visible:lit-focus')).toHaveLength(1);
    // The row's left gutter is the page's (16 / 24) less the link's 8px padding.
    const row = (link?.parentElement?.getAttribute('class') ?? '').split(/\s+/);
    expect(row).toEqual(expect.arrayContaining(['pl-2', 'md:pl-4', 'pr-4', 'md:pr-6']));
    expect(row).not.toContain('px-4');
    expect(row).not.toContain('md:px-6');
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

    // A right-click on the first card starts selecting with it ticked; in
    // select mode a tap on each card toggles it.
    await rightClick('a1');
    for (const name of ['two.png', 'three.png']) await tapCard(name);
    await act(async () => barAction('delete')?.click());

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

describe('Assets top bar: Sort and the "+" (New file menu)', () => {
  it('publishes Sort and the "+" into the top bar, not the page header', async () => {
    listAssets.mockResolvedValue({ ok: true, data: [asset({ folderId: null })] });
    await mount();

    const sortSlot = document.querySelector('[data-test-topbar-sort]');
    const sort = sortSlot?.querySelector<HTMLButtonElement>('button');
    expect(sort?.getAttribute('aria-label')).toBe('Sort');
    const plus = document.querySelector<HTMLButtonElement>(
      '[data-test-topbar-primary] [data-topbar-plus]',
    );
    expect(plus).not.toBeNull();
    // Nothing of either is left in the page's own header.
    const header = document.querySelector('[data-chip-row]');
    expect(header?.querySelector('[data-topbar-plus]')).toBeNull();
    expect(header?.querySelector('[aria-label="Sort"]')).toBeNull();
  });

  it('the "+" is named New file, keeps the tour key and opens Upload files and Add link', async () => {
    listAssets.mockResolvedValue({ ok: true, data: [asset({ folderId: null })] });
    await mount();

    const trigger = document.querySelector<HTMLButtonElement>('[data-topbar-plus]');
    expect(trigger?.getAttribute('aria-label')).toBe('New file');
    expect(trigger?.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    expect(trigger?.getAttribute('data-induction')).toBe(INDUCTION_KEYS.assetsAdd);
    // The label is the button's name; the only text is the aria-hidden laptop face.
    for (const face of Array.from(trigger?.querySelectorAll('[data-topbar-plus-face]') ?? [])) {
      expect(face.getAttribute('aria-hidden')).toBe('true');
    }
    expect(trigger?.querySelector('[data-topbar-plus-face="phone"]')?.textContent).toBe('');
    expect(trigger?.querySelector('svg')).not.toBeNull();
    expect(button('New file')).toBe(trigger ?? undefined);

    await act(async () => trigger?.click());
    await flush();

    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
    const items = [...document.querySelectorAll('[role="menuitem"]')].map((el) =>
      el.textContent?.trim(),
    );
    expect(items).toEqual(['Upload files', 'Add link']);
  });

  it('Sort opens the Assets sort options', async () => {
    listAssets.mockResolvedValue({ ok: true, data: [asset({ folderId: null })] });
    await mount();
    const sort = document.querySelector<HTMLButtonElement>('[data-test-topbar-sort] button');
    await act(async () => sort?.click());
    await flush();
    for (const label of ['Newest first', 'Name', 'Size', 'Type']) {
      expect(text()).toContain(label);
    }
  });
});

describe('Assets has no list search', () => {
  it('no search box, and a ?q= on the URL filters nothing', async () => {
    listAssets.mockResolvedValue({
      ok: true,
      data: [
        asset({ id: 'a1', filename: 'one.png', folderId: null }),
        asset({ id: 'a2', filename: 'two.png', folderId: null }),
      ],
    });
    await mount('/assets?q=one');
    expect(document.querySelector('input[placeholder="Search files"]')).toBeNull();
    expect(text()).toContain('one.png');
    expect(text()).toContain('two.png');
    // Every page read is the plain list: no search argument.
    for (const call of listAssets.mock.calls) expect(call.length).toBeLessThanOrEqual(3);
  });
});

describe('Assets chip row Select (SectionSelect)', () => {
  const two = () =>
    listAssets.mockResolvedValue({
      ok: true,
      data: [
        asset({ id: 'a1', filename: 'one.png', folderId: null }),
        asset({ id: 'a2', filename: 'two.png', folderId: null }),
      ],
    });
  const select = () =>
    document.querySelector<HTMLButtonElement>('[data-chip-row-select] [data-section-select]');

  it('sits at the end of the chip row, off until tapped', async () => {
    two();
    await mount();
    expect(select()).not.toBeNull();
    expect(select()?.textContent).toContain('Select');
    expect(select()?.getAttribute('aria-pressed')).toBe('false');
    expect(document.querySelector('[data-select-bar]')).toBeNull();
  });

  it('a tap starts select mode with nothing ticked; a card tap ticks; a second tap leaves', async () => {
    two();
    await mount();
    await act(async () => select()?.click());
    await flush();
    expect(select()?.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('[data-select-bar]')).not.toBeNull();
    expect(document.querySelector('[data-list-card-tick="on"]')).toBeNull();

    await tapCard('one.png');
    expect(document.querySelector('[data-select-bar-count]')?.textContent).toBe('1 selected');

    await act(async () => select()?.click());
    await flush();
    expect(select()?.getAttribute('aria-pressed')).toBe('false');
    expect(document.querySelector('[data-select-bar]')).toBeNull();
  });

  it('a right-click still starts it, and the Select shows pressed', async () => {
    two();
    await mount();
    await rightClick('a2');
    expect(select()?.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('[data-select-bar-count]')?.textContent).toBe('1 selected');
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

    await rightClick('a1');

    expect(barAction('delete')).not.toBeNull();
    expect(button('Move')).toBeUndefined();
    const labels = [...document.querySelectorAll('button')].map(
      (b) => `${b.textContent ?? ''} ${b.getAttribute('aria-label') ?? ''}`,
    );
    expect(labels.some((label) => label.includes('Move'))).toBe(false);
  });
});

describe('Assets select mode (long-press / right-click, ui/SelectBar)', () => {
  const three = () =>
    listAssets.mockResolvedValue({
      ok: true,
      data: [
        asset({ id: 'a1', filename: 'one.png', folderId: null }),
        asset({ id: 'a2', filename: 'two.png', folderId: null }),
        asset({ id: 'a3', filename: 'three.png', folderId: null }),
      ],
    });

  it('no card has a ⋮ and nothing selects until a right-click', async () => {
    three();
    await mount();
    expect(document.querySelector('[data-card-menu]')).toBeNull();
    expect(document.querySelector('[aria-label^="More actions for"]')).toBeNull();
    expect(document.querySelector('[data-select-bar]')).toBeNull();
    expect(text()).toContain('Recently deleted');
  });

  it('shows the SelectBar with the single-file actions only at count 1, Delete at any count', async () => {
    three();
    await mount();
    await rightClick('a1');

    const bar = document.querySelector('[data-select-bar]');
    expect(bar).not.toBeNull();
    expect(bar?.getAttribute('role')).toBe('toolbar');
    expect(document.querySelector('[data-select-bar-count]')?.textContent).toBe('1 selected');
    expect(barActionIds()).toEqual(['copy-link', 'rename', 'info', 'delete']);
    expect(barAction('delete')?.className).toContain('text-bad');
    // Select all is the bar's extra; the header keeps its tabs (no in-header select row).
    expect(document.querySelector('[data-assets-select-all]')?.textContent).toBe('Select all');
    expect(document.querySelector('[role="tablist"]')).not.toBeNull();
    expect(text()).not.toContain('Recently deleted');

    await tapCard('two.png');
    expect(document.querySelector('[data-select-bar-count]')?.textContent).toBe('2 selected');
    expect(barActionIds()).toEqual(['delete']);

    // Unticking back to one brings the single rows back.
    await tapCard('two.png');
    expect(barActionIds()).toEqual(['copy-link', 'rename', 'info', 'delete']);
  });

  it('Cancel and unticking the last card both leave select mode', async () => {
    three();
    await mount();
    await rightClick('a1');
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[data-select-bar-cancel]')?.click(),
    );
    await flush();
    expect(document.querySelector('[data-select-bar]')).toBeNull();

    await rightClick('a2');
    expect(document.querySelector('[data-select-bar]')).not.toBeNull();
    await tapCard('two.png');
    await flush();
    expect(document.querySelector('[data-select-bar]')).toBeNull();
  });

  it('Delete from the bar hides the ticked files with the Undo toast', async () => {
    three();
    await mount();
    await rightClick('a2');
    await act(async () => barAction('delete')?.click());
    await flush();
    expect(
      showToast.mock.calls.some(
        ([options]) =>
          (options as { title?: string }).title ===
          'File deleted. Undo or find it in Recently deleted.',
      ),
    ).toBe(true);
    expect(text()).not.toContain('two.png');
    expect(document.querySelector('[data-select-bar]')).toBeNull();
  });
});

describe('Assets Load more (keyset pages)', () => {
  const cursor = { uploadedAt: '2026-10-01T00:00:00Z', id: 'a1' };
  const loadMore = () => document.querySelector<HTMLButtonElement>('[data-assets-load-more]');

  it('renders no Load more when the first page is the last', async () => {
    listAssets.mockResolvedValue({ ok: true, data: [asset({ folderId: null })] });
    await mount();
    expect(text()).toContain('inside-brand.png');
    expect(loadMore()).toBeNull();
    expect(button('Load more')).toBeUndefined();
  });

  it('renders Load more when a full page has another after it, reads the next page from the cursor, and appends without duplicates', async () => {
    // A full first page (one screen) with another page after it shows the button.
    const fillers = Array.from({ length: getFillCount() - 1 }, (_u, i) =>
      asset({ id: `f${i}`, filename: `f${i}.png`, folderId: null }),
    );
    listAssets
      .mockResolvedValueOnce({
        ok: true,
        data: {
          items: [asset({ id: 'a1', filename: 'one.png', folderId: null }), ...fillers],
          next: { done: false, cursor },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          // a1 again (uploaded between reads) must not render twice.
          items: [
            asset({ id: 'a1', filename: 'one.png', folderId: null }),
            asset({ id: 'a2', filename: 'two.png', folderId: null }),
          ],
          next: { done: true },
        },
      });
    await mount();
    const control = loadMore();
    expect(control).not.toBeNull();
    expect(control?.textContent?.trim()).toBe('Load more');
    // The shared Button: 44px touch target, token classes only.
    expect(control?.className).toContain('min-h-11');
    expect(control?.className).not.toContain('dark:');

    await act(async () => control?.click());
    await flush();

    expect(listAssets).toHaveBeenCalledTimes(2);
    expect(listAssets.mock.calls[0]?.[2]).toBeUndefined();
    expect(listAssets.mock.calls[1]?.[1]).toBe('w1');
    expect(listAssets.mock.calls[1]?.[2]).toEqual(cursor);
    const titles = [...document.querySelectorAll<HTMLElement>('span[title]')].map((el) =>
      el.getAttribute('title'),
    );
    expect(titles.filter((t) => t === 'one.png')).toHaveLength(1);
    expect(titles).toContain('two.png');
    // The last page hides the control.
    expect(loadMore()).toBeNull();
  });

  it('a failed next page keeps the loaded files and toasts "Couldn\'t load more files."', async () => {
    // A short first page reads the next one silently; it fails: the toast says
    // so and Load more stays as the way to try again.
    listAssets
      .mockResolvedValueOnce({
        ok: true,
        data: { items: [asset({ id: 'a1', filename: 'one.png' })], next: { done: false, cursor } },
      })
      .mockResolvedValueOnce({ ok: false, error: { message: 'boom' } });
    await mount();
    await flush();
    expect(text()).toContain('one.png');
    expect(text()).not.toContain('boom');
    expect(
      showToast.mock.calls.some(
        ([options]) =>
          (options as { title?: string }).title === "Couldn't load more files. Try again.",
      ),
    ).toBe(true);
    expect(loadMore()).not.toBeNull();
  });

  it('?asset= for a file beyond the loaded pages is read on its own, never called gone', async () => {
    listAssets
      .mockResolvedValueOnce({
        ok: true,
        data: { items: [asset({ id: 'a1', filename: 'one.png' })], next: { done: false, cursor } },
      })
      // The silent fill's next page (a short first page reads on).
      .mockResolvedValue({ ok: true, data: { items: [], next: { done: true } } });
    getAssetItem.mockResolvedValue({
      ok: true,
      data: [asset({ id: 'old-1', filename: 'older.png' })],
    });
    await mount('/assets?asset=old-1');
    await flush();
    expect(getAssetItem).toHaveBeenCalledTimes(1);
    expect(getAssetItem.mock.calls[0]?.slice(1)).toEqual(['w1', 'old-1']);
    expect(
      showToast.mock.calls.some(
        ([options]) => (options as { title?: string }).title === 'This file was deleted.',
      ),
    ).toBe(false);
  });
});
