// @vitest-environment jsdom
// W5 Briefs list: a load failure shows LoadError ("Couldn't load briefs.") with
// Retry and never the server's text, and Retry re-runs the same workspace read;
// the read is workspace-scoped and paged on the server; the chip defaults to
// Open and lives in the URL with the search; empty states; the count line
// follows the filter; cards carry a real title link with no buttons nested in
// a role=link, and no Close.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BriefWithThumbnail } from '@srtdio/briefs';
import { BriefsPage } from '@/components/pages/BriefsPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
    expect(text()).toContain('51 briefs');
  });
});

describe('Briefs list filter and search', () => {
  it('defaults to Open and the count line reflects it ("2 of 3 briefs")', async () => {
    listBriefs.mockResolvedValue({
      ok: true,
      data: [brief('b1'), brief('b2'), brief('b3', { status: 'closed' })],
    });
    await mount();
    expect(text()).toContain('2 of 3 briefs');
    expect(text()).toContain('Brief b1');
    expect(text()).not.toContain('Brief b3');
  });

  it('reads the chip and search from the URL and writes changes back', async () => {
    listBriefs.mockResolvedValue({
      ok: true,
      data: [brief('b1', { title: 'Launch reel' }), brief('b2', { status: 'closed' })],
    });
    await mount('/briefs?status=closed&q=zzz');
    expect(text()).toContain('No matches');
    // The empty state's text button, not the search field's own X (aria-label "Clear search").
    const clear = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === 'Clear search',
    );
    await act(async () => clear?.click());
    expect(location).toBe('/briefs?status=all');
    expect(text()).toContain('Launch reel');
    expect(text()).toContain('2 briefs');
  });

  it('truly empty with brief.create: "Write your first brief"', async () => {
    listBriefs.mockResolvedValue({ ok: true, data: [] });
    await mount();
    expect(button('Write your first brief')).toBeDefined();
  });

  it('truly empty without brief.create: no create button', async () => {
    capability.create = false;
    listBriefs.mockResolvedValue({ ok: true, data: [] });
    await mount();
    expect(button('Write your first brief')).toBeUndefined();
    expect(text()).toContain('No briefs yet');
  });
});

describe('Briefs list cards', () => {
  it('the title is a real link, no role=link wrapper, no buttons inside a link, no Close', async () => {
    listBriefs.mockResolvedValue({ ok: true, data: [brief('b7', { number: 7 })] });
    await mount();
    const link = [...document.querySelectorAll('a')].find((a) => a.textContent === 'Brief b7');
    expect(link?.getAttribute('href')).toBe('/b/acme-7');
    expect(document.querySelector('[role="link"]')).toBeNull();
    expect(document.querySelector('a button, [role="link"] button')).toBeNull();
    expect(button('Close')).toBeUndefined();
  });
});
