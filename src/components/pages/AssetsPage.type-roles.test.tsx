// @vitest-environment jsdom
// Type roles on Assets (design rules, 24 Oct 2026): an asset card title is
// base/500, its size line is sm fg-3 meta, the no-match state reads as an empty
// state (lg/600 title, base fg-2 description), and an empty tab line is base
// fg-2 copy. Rendered for real in jsdom; mocks mirror
// assets/x6-assets-page.test.tsx.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetsPage } from '@/components/pages/AssetsPage';
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

/** Type into the header search the way React sees a user edit. */
async function typeSearch(value: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('input[placeholder="Search files"]');
  expect(input).not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
}

beforeEach(() => {
  listAssets.mockReset().mockResolvedValue({ ok: true, data: [asset()] });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('Assets page type roles', () => {
  it('a card title is base/500 and its size line is sm fg-3 meta', async () => {
    await mount();
    const title = [...document.querySelectorAll<HTMLElement>('span[title]')].find(
      (el) => el.getAttribute('title') === 'inside-brand.png',
    );
    expect(title).toBeDefined();
    expectRole(title as HTMLElement, ['text-base', 'font-medium']);
    const size = byText(humanizeSize(2048));
    const meta = size.parentElement as HTMLElement;
    expectRole(meta, ['text-sm', 'tabular-nums', 'text-fg-3']);
  });

  it('a search with no match reads as an empty state', async () => {
    await mount();
    await typeSearch('zzz');
    const title = [...document.querySelectorAll('p')].find((p) =>
      p.textContent?.startsWith('No assets match'),
    );
    expect(title).toBeDefined();
    expectRole(title as HTMLElement, ['text-lg', 'font-semibold', 'text-fg']);
    expectRole(byText('Try a different name or clear the search.'), ['text-base', 'text-fg-2']);
  });

  it('an empty tab line is base fg-2 copy', async () => {
    await mount('/assets?type=pdf');
    const line = document.querySelector('[data-asset-tab-empty="pdf"]');
    expect(line?.textContent).toBe(TAB_EMPTY.pdf);
    expectRole(line as HTMLElement, ['text-base', 'text-fg-2']);
  });
});
