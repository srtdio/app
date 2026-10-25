// @vitest-environment jsdom
// W5 Briefs list: a load failure shows LoadError ("Couldn't load briefs.") with
// Retry and never the server's text, and Retry re-runs the same workspace read;
// the read is workspace-scoped and paged on the server; the chip defaults to
// Open and lives in the URL with the search; empty states (Clear only with a
// typed search); agency sort; the loading skeleton; cards carry a real title
// link with no buttons nested in a role=link, and no Close.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BriefWithThumbnail } from '@srtdio/briefs';
import { BriefsPage } from '@/components/pages/BriefsPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no matchMedia; the agency-side SortMenu reads it. A phone-width stub.
if (typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
}

const { listBriefs, capability } = vi.hoisted(() => ({
  listBriefs: vi.fn(),
  capability: { create: true },
}));

vi.mock('@srtdio/briefs', () => ({
  BRIEFS_PAGE_SIZE: 50,
  listBriefs: (...args: unknown[]) => listBriefs(...args),
}));
vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: null } }) } },
}));
vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: () => ({
    workspaceId: 'w1',
    workspaceKey: 'ACME',
    workspaces: [{ id: 'w1', timezone: 'UTC', week_start_day: 1 }],
  }),
}));
vi.mock('@/lib/workspace-context-capability', () => ({
  useWorkspaceCapability: (key: string) => (key === 'brief.create' ? capability.create : false),
}));
vi.mock('@/lib/use-workspace-data-changed', () => ({ useWorkspaceDataChanged: () => {} }));
vi.mock('@/components/pages/CreateBriefSheet', () => ({ CreateBriefSheet: () => null }));

function brief(id: string, over: Partial<BriefWithThumbnail> = {}): BriefWithThumbnail {
  return {
    id,
    workspace_id: 'w1',
    number: Number(id.replace(/\D/g, '')) || 1,
    title: `Brief ${id}`,
    objective: 'Objective',
    legacy_author_name: null,
    status: 'open',
    target_date: null,
    reference_links: null,
    mentions: null,
    format_requested: null,
    brand_requirements: null,
    closed_at: null,
    closed_by: null,
    created_by: 'u1',
    created_via: 'manual',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    deleted_at: null,
    row_version: 1,
    thumbnailAssetVersionId: null,
    ...over,
  };
}

let root: Root | null = null;
let location = '';

function LocationProbe() {
  const here = useLocation();
  location = `${here.pathname}${here.search}`;
  return null;
}

async function mount(path = '/briefs') {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/briefs"
            element={
              <>
                <BriefsPage />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
  });
  await act(async () => new Promise((r) => setTimeout(r, 0)));
}

const text = () => document.body.textContent ?? '';
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label,
  );

beforeEach(() => {
  listBriefs.mockReset();
  capability.create = true;
  location = '';
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('Briefs list load failure', () => {
  it('shows "Couldn\'t load briefs." with Retry and no raw server text; Retry re-reads', async () => {
    listBriefs
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'unknown', message: 'permission denied for table briefs' },
      })
      .mockResolvedValue({ ok: true, data: [brief('b1')] });
    await mount();
    expect(text()).toContain("Couldn't load briefs.");
    expect(text()).not.toContain('permission denied');
    expect(text()).not.toContain('Could not load briefs');
    expect(button('Retry')).toBeDefined();

    await act(async () => button('Retry')?.click());
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    expect(listBriefs).toHaveBeenCalledTimes(2);
    expect(listBriefs.mock.calls[1]?.[1]).toEqual(listBriefs.mock.calls[0]?.[1]);
    expect(text()).toContain('Brief b1');
    expect(text()).not.toContain("Couldn't load briefs.");
  });
});

describe('Briefs list read', () => {
  it('reads by workspace_id on the server, one page at a time', async () => {
    const full = Array.from({ length: 50 }, (_, i) => brief(`p${i + 1}`));
    listBriefs
      .mockResolvedValueOnce({ ok: true, data: full })
      .mockResolvedValueOnce({ ok: true, data: [brief('p51')] });
    await mount('/briefs?status=all');
    expect(listBriefs).toHaveBeenCalledTimes(2);
    expect(listBriefs.mock.calls[0]?.[1]).toEqual({ workspaceId: 'w1', limit: 50, offset: 0 });
    expect(listBriefs.mock.calls[1]?.[1]).toEqual({ workspaceId: 'w1', limit: 50, offset: 50 });
    expect(text()).toContain('Brief p51');
  });
});

describe('Briefs list filter and search', () => {
  it('defaults to Open, with no total count line', async () => {
    listBriefs.mockResolvedValue({
      ok: true,
      data: [brief('b1'), brief('b2'), brief('b3', { status: 'closed' })],
    });
    await mount();
    expect(text()).not.toContain('2 of 3 briefs');
    expect(text()).toContain('Brief b1');
    expect(text()).not.toContain('Brief b3');
  });

  it('reads the chip and search from the URL and writes changes back', async () => {
    listBriefs.mockResolvedValue({
      ok: true,
      data: [brief('b1', { title: 'Launch reel' }), brief('b2', { status: 'closed' })],
    });
    await mount('/briefs?status=closed&q=zzz');
    expect(text()).toContain('Try another word for "zzz".');
    // Clear clears the search only: the Closed chip stays.
    await act(async () => clearText()?.click());
    expect(location).toBe('/briefs?status=closed');
    expect(text()).toContain('Brief b2');
    expect(text()).not.toContain('Launch reel');
  });

  it('client with no briefs: "Open briefs show up here." and only the header New brief', async () => {
    listBriefs.mockResolvedValue({ ok: true, data: [] });
    await mount();
    expect(text()).toContain('Open briefs show up here.');
    expect(text()).not.toContain('Tell the agency what you need next.');
    const newBriefs = [...document.querySelectorAll<HTMLButtonElement>('button')].filter(
      (b) => b.textContent?.trim() === 'New brief',
    );
    expect(newBriefs).toHaveLength(1);
    expect(clearText()).toBeUndefined();
  });

  it('agency with no briefs: one line, no heading, no create button', async () => {
    capability.create = false;
    listBriefs.mockResolvedValue({ ok: true, data: [] });
    await mount();
    expect(button('New brief')).toBeUndefined();
    expect(text()).toContain('Briefs from the client show up here.');
    expect(text()).not.toContain('No briefs yet');
    expect(text()).not.toContain('Open briefs show up here.');
  });
});

describe('Briefs sort and loading', () => {
  it('agency side gets the Sort control; the client side does not', async () => {
    listBriefs.mockResolvedValue({ ok: true, data: [brief('b1')] });
    capability.create = false;
    await mount();
    expect(button('Sort')).toBeDefined();
    act(() => root?.unmount());
    document.body.innerHTML = '';
    capability.create = true;
    await mount();
    expect(button('Sort')).toBeUndefined();
  });

  it('shows a list-shaped skeleton while loading, never "Loading briefs"', async () => {
    listBriefs.mockReturnValue(new Promise(() => {}));
    await mount();
    expect(document.querySelector('[data-testid="briefs-skeleton"]')).not.toBeNull();
    expect(document.querySelectorAll('[data-brief-card-skeleton]').length).toBeGreaterThan(0);
    expect(text()).not.toContain('Loading briefs');
  });
});

// The empty state's own "Clear search" text button (not the header X, which
// has only an aria-label and no text).
const clearText = () =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === 'Clear search',
  );

describe('Briefs zero-result headings', () => {
  it('client, Open chip, no open briefs, no search: "Open briefs show up here." and no Clear', async () => {
    listBriefs.mockResolvedValue({ ok: true, data: [brief('b1', { status: 'closed' })] });
    await mount();
    expect(text()).toContain('Open briefs show up here.');
    expect(clearText()).toBeUndefined();
  });

  it('Closed chip, empty search, no closed briefs: "Closed briefs show up here." and no Clear', async () => {
    listBriefs.mockResolvedValue({ ok: true, data: [brief('b1')] });
    await mount('/briefs?status=closed');
    expect(text()).toContain('Closed briefs show up here.');
    expect(clearText()).toBeUndefined();
  });

  it('non-empty search, zero results: names the query with Clear', async () => {
    listBriefs.mockResolvedValue({ ok: true, data: [brief('b1', { title: 'Launch reel' })] });
    await mount('/briefs?q=diwali');
    expect(text()).toContain('Try another word for "diwali".');
    expect(clearText()).toBeDefined();
    await act(async () => clearText()?.click());
    expect(location).toBe('/briefs');
  });

  it('each zero state renders the same markup in light and dark mode', async () => {
    const cases: { path: string; data: BriefWithThumbnail[]; heading: string }[] = [
      {
        path: '/briefs',
        data: [brief('b1', { status: 'closed' })],
        heading: 'Open briefs show up here.',
      },
      {
        path: '/briefs?status=closed',
        data: [brief('b1')],
        heading: 'Closed briefs show up here.',
      },
      {
        path: '/briefs?q=diwali',
        data: [brief('b1')],
        heading: 'Try another word for "diwali".',
      },
    ];
    for (const item of cases) {
      const markup: string[] = [];
      for (const dark of [false, true]) {
        document.documentElement.classList.toggle('dark', dark);
        listBriefs.mockResolvedValue({ ok: true, data: item.data });
        await mount(item.path);
        expect(text()).toContain(item.heading);
        markup.push(document.body.innerHTML);
        act(() => root?.unmount());
        root = null;
        document.body.innerHTML = '';
      }
      expect(markup[1]).toBe(markup[0]);
    }
    document.documentElement.classList.remove('dark');
  });
});

describe('Briefs list cards', () => {
  it('the card is one real link named by the title, no role=link wrapper, no buttons inside a link, no Close', async () => {
    listBriefs.mockResolvedValue({ ok: true, data: [brief('b7', { number: 7 })] });
    await mount();
    const link = [...document.querySelectorAll('a')].find(
      (a) => a.getAttribute('aria-label') === 'Brief b7',
    );
    expect(link?.getAttribute('href')).toBe('/b/acme-7');
    expect(link?.hasAttribute('data-brief-card-link')).toBe(true);
    expect(document.querySelector('[role="link"]')).toBeNull();
    expect(document.querySelector('a button, [role="link"] button')).toBeNull();
    expect(button('Close')).toBeUndefined();
  });
});
