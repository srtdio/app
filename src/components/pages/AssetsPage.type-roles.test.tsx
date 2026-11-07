// @vitest-environment jsdom
// Type roles on Assets (design rules, 24 Oct 2026; ui/ListCard, 7 Nov): an
// asset card title is the ListCard heading, its facts line the secondary
// preview and its added time the meta role, and an empty tab line is base fg-2
// copy. Assets has no list search (decision B, 7 Nov). Rendered for real in jsdom; mocks mirror
// assets/x6-assets-page.test.tsx.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetsPage } from '@/components/pages/AssetsPage';
import { resetSessionReads } from '@/lib/session-read';
import { TAB_EMPTY, humanizeSize, type AssetListItem } from '@/lib/assets';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { listAssets } = vi.hoisted(() => ({ listAssets: vi.fn() }));

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
  useOptionalToast: () => ({ show: vi.fn(() => 'toast-1'), dismiss: vi.fn() }),
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
    fetchMemberRole: async () => 'owner',
    findAssetsInUse: vi.fn(),
  };
});
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
    folderId: null,
    tags: [],
    uploadedAt: '2026-10-01T00:00:00Z',
    currentVersionId: 'v1',
    kind: 'image',
    mimeType: 'image/png',
    sizeBytes: 2048,
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

beforeEach(() => {
  listAssets.mockReset().mockResolvedValue({ ok: true, data: [asset()] });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  // The kept list and tab outlive the page; each test starts a fresh session.
  resetSessionReads();
});

describe('Assets page type roles', () => {
  it('a file name is the ListCard heading, its facts the secondary line, its time meta', async () => {
    await mount();
    const title = [...document.querySelectorAll<HTMLElement>('span[title]')].find(
      (el) => el.getAttribute('title') === 'inside-brand.png',
    );
    expect(title).toBeDefined();
    expectRole(title?.parentElement as HTMLElement, ['text-lg', 'font-semibold', 'truncate']);
    const facts = byText(`PNG · ${humanizeSize(2048)}`);
    expect(facts.hasAttribute('data-asset-meta')).toBe(true);
    expectRole(facts, ['text-md', 'text-fg-2', 'truncate']);
    const time = document.querySelector<HTMLElement>('[data-asset-uploaded]');
    // formatAdded: a clock time today, else the day (never ticks).
    expect(time?.textContent).toMatch(/^\d{1,2}:\d{2} (AM|PM)$|^\d{1,2} [A-Z][a-z]{2}( \d{4})?$/);
    expectRole(time as HTMLElement, ['font-mono', 'text-sm', 'tabular-nums', 'text-fg-3']);
  });

  it('no list search: no search box on Assets', async () => {
    await mount();
    expect(document.querySelector('input[placeholder="Search files"]')).toBeNull();
    expect(document.querySelector('input[type="search"]')).toBeNull();
  });

  it('an empty tab line is base fg-2 copy', async () => {
    await mount('/assets?type=docs');
    const line = document.querySelector('[data-asset-tab-empty="docs"]');
    expect(line?.textContent).toBe(TAB_EMPTY.docs);
    expectRole(line as HTMLElement, ['text-base', 'text-fg-2']);
  });

  it('an old ?type=pdf lands on the Docs tab', async () => {
    await mount('/assets?type=pdf');
    expect(document.querySelector('[data-asset-tab-empty="docs"]')).not.toBeNull();
    expect(
      document.querySelector('[data-asset-tab="docs"]')?.getAttribute('aria-selected'),
    ).toBe('true');
  });
});
