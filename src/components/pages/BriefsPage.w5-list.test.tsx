// @vitest-environment jsdom
// W5 Briefs list: a load failure shows LoadError ("Couldn't load briefs.") with
// Retry and never the server's text, and Retry re-runs the same workspace read;
// the read is workspace-scoped and keyset paged on the server (Load more); the
// chip defaults to Open and lives in the URL; there is no screen search (decision B);
// empty states (no Clear); the "+" (live for approvers, blocked for creators) is
// published into the top bar (decision A), and there is no Sort; the loading
// skeleton; cards carry a real title link with no buttons nested in a role=link,
// and no Close.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BriefWithThumbnail } from '@srtdio/briefs';
import { BriefsPage, briefsLoadMore } from '@/components/pages/BriefsPage';
import { TopbarActionsProvider, useTopbarActionsValue } from '@/components/shell/topbar-actions';
import { getFillCount } from '@/lib/use-fill-count';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no matchMedia; a phone-width stub for the parts that read it.
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

const { listBriefs, countBriefs, capability } = vi.hoisted(() => ({
  listBriefs: vi.fn(),
  countBriefs: vi.fn(),
  capability: { create: true as boolean | null },
}));

vi.mock('@/lib/brief-list', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // The page reads keyset pages; a mocked plain list is one (last) page, and a
    // mocked { items, next } page passes through as is.
    listBriefsPage: async (...args: unknown[]) => {
      const result = (await listBriefs(...args)) as
        | { ok: true; data: unknown }
        | { ok: false; error: unknown };
      if (!result.ok || !Array.isArray(result.data)) return result;
      return { ok: true, data: { items: result.data, next: { done: true } } };
    },
    // The first page paints before its thumbnails; here the mocked rows carry
    // their thumbnails already, so the thumbnails read finds nothing more.
    listBriefsFirstPage: async (...args: unknown[]) => {
      const result = (await listBriefs(...args)) as
        | { ok: true; data: unknown }
        | { ok: false; error: unknown };
      if (!result.ok) return result;
      const page = Array.isArray(result.data)
        ? { items: result.data, next: { done: true } }
        : { ...(result.data as { items: unknown[]; next: unknown }) };
      const thumbs = Promise.resolve({ ok: true, data: new Map() });
      return { ok: true, data: { ...page, thumbs } };
    },
  };
});
// Chip counts are server HEAD counts; the page reads them through this module.
vi.mock('@/lib/brief-counts', () => ({
  countBriefsByFilter: (...args: unknown[]) => countBriefs(...args),
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

// What the page publishes into the app top bar (sort, "+"), rendered the way
// Topbar renders it.
function TopbarProbe() {
  const { sort, primary } = useTopbarActionsValue();
  return (
    <div data-topbar-probe="">
      {sort}
      {primary}
    </div>
  );
}

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
        <TopbarActionsProvider>
          <TopbarProbe />
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
        </TopbarActionsProvider>
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
  countBriefs.mockReset();
  countBriefs.mockResolvedValue({ ok: true, data: { all: 0, open: 0, closed: 0 } });
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
  const cursor = { createdAt: '2026-10-01T00:00:00Z', id: 'p1' };
  const loadMore = () => document.querySelector<HTMLButtonElement>('[data-briefs-load-more]');

  it('reads the first keyset page by workspace_id, with no Load more when it is the last', async () => {
    listBriefs.mockResolvedValue({ ok: true, data: [brief('p1')] });
    await mount('/briefs?status=all');
    expect(listBriefs).toHaveBeenCalledTimes(1);
    expect(listBriefs.mock.calls[0]?.[1]).toBe('w1');
    expect(listBriefs.mock.calls[0]?.[2]).toBeUndefined();
    expect(text()).toContain('Brief p1');
    expect(loadMore()).toBeNull();
    expect(button('Load more')).toBeUndefined();
  });

  it('a short first page reads the next page silently: appended, no duplicates, no Load more', async () => {
    listBriefs
      .mockResolvedValueOnce({
        ok: true,
        data: { items: [brief('p1')], next: { done: false, cursor } },
      })
      .mockResolvedValueOnce({
        ok: true,
        // p1 again (created between reads) must not render twice.
        data: { items: [brief('p1'), brief('p2')], next: { done: true } },
      });
    await mount('/briefs?status=all');
    await act(async () => new Promise((r) => setTimeout(r, 0)));

    expect(listBriefs).toHaveBeenCalledTimes(2);
    expect(listBriefs.mock.calls[1]?.[1]).toBe('w1');
    expect(listBriefs.mock.calls[1]?.[2]).toEqual(cursor);
    const links = [...document.querySelectorAll('a')].map((a) => a.getAttribute('aria-label'));
    expect(links.filter((label) => label === 'Brief p1')).toHaveLength(1);
    expect(links).toContain('Brief p2');
    expect(loadMore()).toBeNull();
  });

  it('a full first page shows Load more; a tap reads the next page from the cursor', async () => {
    const full = Array.from({ length: getFillCount() }, (_u, i) => brief(`f${i}`));
    listBriefs
      .mockResolvedValueOnce({ ok: true, data: { items: full, next: { done: false, cursor } } })
      .mockResolvedValueOnce({ ok: true, data: { items: [brief('p2')], next: { done: true } } });
    await mount('/briefs?status=all');
    const control = loadMore();
    expect(listBriefs).toHaveBeenCalledTimes(1);
    expect(control?.textContent?.trim()).toBe('Load more');
    // The shared Button: 44px touch target, token classes only.
    expect(control?.className).toContain('min-h-11');
    expect(control?.className).not.toContain('dark:');

    await act(async () => control?.click());
    await act(async () => new Promise((r) => setTimeout(r, 0)));

    expect(listBriefs).toHaveBeenCalledTimes(2);
    expect(listBriefs.mock.calls[1]?.[2]).toEqual(cursor);
    const links = [...document.querySelectorAll('a')].map((a) => a.getAttribute('aria-label'));
    expect(links).toContain('Brief p2');
    expect(loadMore()).toBeNull();
  });

  it('Open chip: 1 open brief behind a page of closed ones shows the brief and no Load more', async () => {
    const closed = Array.from({ length: getFillCount() }, (_u, i) =>
      brief(`c${i}`, { status: 'closed' }),
    );
    listBriefs
      .mockResolvedValueOnce({ ok: true, data: { items: closed, next: { done: false, cursor } } })
      .mockResolvedValueOnce({ ok: true, data: { items: [brief('o1')], next: { done: true } } });
    await mount('/briefs?status=open');
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    expect(text()).toContain('Brief o1');
    expect(text()).not.toContain('Open briefs show up here.');
    expect(loadMore()).toBeNull();
  });
});

describe('briefsLoadMore', () => {
  it('renders the control only while another page exists', () => {
    expect(briefsLoadMore({ done: true }, false, () => {})).toEqual([]);
    const shown = briefsLoadMore(
      { done: false, cursor: { createdAt: '2026-10-01T00:00:00Z', id: 'b1' } },
      false,
      () => {},
    );
    expect(shown).toHaveLength(1);
  });
});

describe('Briefs list filter (no screen search)', () => {
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

  it('reads the chip from the URL; a stale ?q= is ignored and dropped on the next chip tap', async () => {
    listBriefs.mockResolvedValue({
      ok: true,
      data: [brief('b1', { title: 'Launch reel' }), brief('b2', { status: 'closed' })],
    });
    await mount('/briefs?status=closed&q=zzz');
    expect(text()).not.toContain('Try another word');
    expect(text()).toContain('Brief b2');
    expect(text()).not.toContain('Launch reel');
    // One plain read: no search argument reaches the server.
    expect(listBriefs).toHaveBeenCalledTimes(1);
    expect(listBriefs.mock.calls[0]?.[2]).toBeUndefined();
    await act(async () => button('All')?.click());
    expect(location).toBe('/briefs?status=all');
    expect(text()).toContain('Launch reel');
  });

  it('there is no search field on the screen', async () => {
    listBriefs.mockResolvedValue({ ok: true, data: [brief('b1')] });
    await mount();
    expect(document.querySelector('input[placeholder="Search briefs"]')).toBeNull();
    expect(document.querySelector('input[type="search"]')).toBeNull();
  });

  it('client with no briefs: "Open briefs show up here." and only the top bar "+"', async () => {
    listBriefs.mockResolvedValue({ ok: true, data: [] });
    await mount();
    expect(text()).toContain('Open briefs show up here.');
    expect(text()).not.toContain('Tell the agency what you need next.');
    const newBriefs = [...document.querySelectorAll<HTMLButtonElement>('button')].filter(
      (b) => b.getAttribute('aria-label') === 'New brief' || b.textContent?.trim() === 'New brief',
    );
    expect(newBriefs).toHaveLength(1);
    // It is the top bar's filled "+", carrying the old tour target.
    expect(newBriefs[0]!.closest('[data-topbar-probe]')).not.toBeNull();
    expect(newBriefs[0]!.hasAttribute('data-topbar-plus')).toBe(true);
    expect(newBriefs[0]!.getAttribute('data-induction')).toBe('briefs-new');
    expect(clearText()).toBeUndefined();
  });

  it('creator with no briefs: one line, no heading, only the blocked top bar "+"', async () => {
    capability.create = false;
    listBriefs.mockResolvedValue({ ok: true, data: [] });
    await mount();
    const plus = button('New brief');
    expect(plus).toBeDefined();
    expect(plus!.closest('[data-topbar-probe]')).not.toBeNull();
    expect(plus!.getAttribute('aria-disabled')).toBe('true');
    expect(plus!.hasAttribute('disabled')).toBe(false);
    expect(text()).toContain('Briefs from approvers show up here.');
    expect(text()).not.toContain('No briefs yet');
    expect(text()).not.toContain('Open briefs show up here.');
  });
});

describe('Briefs top bar and loading', () => {
  it('no Sort on either side (fixed order, 9 Nov 2026)', async () => {
    listBriefs.mockResolvedValue({ ok: true, data: [brief('b1')] });
    capability.create = false;
    await mount();
    expect(button('Sort')).toBeUndefined();
    act(() => root?.unmount());
    document.body.innerHTML = '';
    capability.create = true;
    await mount();
    expect(button('Sort')).toBeUndefined();
  });

  it('capability still unknown: the "+" slot stays empty (never a blocked "+" that turns live)', async () => {
    listBriefs.mockResolvedValue({ ok: true, data: [brief('b1')] });
    capability.create = null;
    await mount();
    expect(button('New brief')).toBeUndefined();
  });

  it('creator list: open by due date (undated last), then closed by closed_at newest first', async () => {
    capability.create = false;
    listBriefs.mockResolvedValue({
      ok: true,
      data: [
        brief('undated', { title: 'Undated', target_date: null }),
        brief('later', { title: 'Later', target_date: '2099-02-01' }),
        brief('sooner', { title: 'Sooner', target_date: '2099-01-01' }),
        brief('shut-old', {
          title: 'Shut old',
          status: 'closed',
          closed_at: '2026-01-01T00:00:00Z',
        }),
        brief('shut-new', {
          title: 'Shut new',
          status: 'closed',
          closed_at: '2026-06-01T00:00:00Z',
        }),
      ],
    });
    await mount('/briefs?status=all');
    const ids = [...document.querySelectorAll('[data-brief-card]')].map((card) =>
      card.textContent?.includes('Undated')
        ? 'undated'
        : card.textContent?.includes('Later')
          ? 'later'
          : card.textContent?.includes('Sooner')
            ? 'sooner'
            : card.textContent?.includes('Shut old')
              ? 'shut-old'
              : 'shut-new',
    );
    expect(ids).toEqual(['sooner', 'later', 'undated', 'shut-new', 'shut-old']);
  });

  it('shows a list-shaped skeleton while loading, never "Loading briefs"', async () => {
    listBriefs.mockReturnValue(new Promise(() => {}));
    await mount();
    expect(document.querySelector('[data-testid="briefs-skeleton"]')).not.toBeNull();
    expect(document.querySelectorAll('[data-brief-card-skeleton]').length).toBeGreaterThan(0);
    expect(text()).not.toContain('Loading briefs');
  });
});

// The old empty state's "Clear search" text button: gone with the screen search.
const clearText = () =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === 'Clear search',
  );

describe('Briefs zero-result headings', () => {
  it('client, Open chip, no open briefs: "Open briefs show up here." and no Clear', async () => {
    listBriefs.mockResolvedValue({ ok: true, data: [brief('b1', { status: 'closed' })] });
    await mount();
    expect(text()).toContain('Open briefs show up here.');
    expect(clearText()).toBeUndefined();
  });

  it('Closed chip, no closed briefs: "Closed briefs show up here." and no Clear', async () => {
    listBriefs.mockResolvedValue({ ok: true, data: [brief('b1')] });
    await mount('/briefs?status=closed');
    expect(text()).toContain('Closed briefs show up here.');
    expect(clearText()).toBeUndefined();
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

// The chip buttons by label (the count, when shown, follows the label).
const chipText = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')]
    .map((b) => b.textContent?.trim() ?? '')
    .find((t) => t === label || t.startsWith(`${label} `));

describe('Briefs chip counts', () => {
  it('shows the server totals, not the loaded rows, as plain text', async () => {
    // One loaded row, but the workspace holds 250: the chips say 250 / 200 / 50.
    listBriefs
      .mockResolvedValueOnce({
        ok: true,
        data: { items: [brief('p1')], next: { done: false, cursor: { createdAt: 'x', id: 'p1' } } },
      })
      .mockResolvedValue({ ok: true, data: { items: [], next: { done: true } } });
    countBriefs.mockResolvedValue({ ok: true, data: { all: 250, open: 200, closed: 50 } });
    await mount();
    expect(countBriefs).toHaveBeenCalledTimes(1);
    expect(countBriefs.mock.calls[0]?.[1]).toBe('w1');
    expect(countBriefs.mock.calls[0]?.[2]).toBe('');
    expect(chipText('All')).toBe('All 250');
    expect(chipText('Open')).toBe('Open 200');
    expect(chipText('Closed')).toBe('Closed 50');
  });

  it('shows labels alone when the count read fails', async () => {
    listBriefs.mockResolvedValue({ ok: true, data: [brief('p1')] });
    countBriefs.mockResolvedValue({ ok: false, error: { code: 'unknown', message: 'x' } });
    await mount();
    expect(chipText('All')).toBe('All');
    expect(chipText('Open')).toBe('Open');
  });

  it('re-reads the counts with the list on Retry', async () => {
    listBriefs
      .mockResolvedValueOnce({ ok: false, error: { code: 'unknown', message: 'x' } })
      .mockResolvedValue({ ok: true, data: [brief('b1')] });
    await mount();
    expect(countBriefs).toHaveBeenCalledTimes(1);
    await act(async () => button('Retry')?.click());
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    expect(countBriefs).toHaveBeenCalledTimes(2);
  });

  it('reads the counts once with no search, and never again on its own', async () => {
    listBriefs.mockResolvedValue({ ok: true, data: [brief('b1', { title: 'Launch reel' })] });
    await mount();
    await act(async () => new Promise((r) => setTimeout(r, 400)));
    expect(listBriefs).toHaveBeenCalledTimes(1);
    expect(countBriefs).toHaveBeenCalledTimes(1);
    expect(countBriefs.mock.calls[0]?.[2]).toBe('');
    expect(text()).toContain('Launch reel');
  });
});
