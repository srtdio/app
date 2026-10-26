// @vitest-environment jsdom
// Briefs first paint: the list paints once the rows AND the chip counts are in
// (never the cards first and the chip numbers after), and the thumbnails read
// (a second round over the rows' ids) does not hold it: each card's fixed 64px
// tile fills when it lands. A page with a reference-link brief (whose card
// height depends on the thumbnail) still waits for the thumbnails.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BriefWithThumbnail } from '@srtdio/briefs';
import type { Result } from '@srtdio/rpc';
import { BriefsPage } from '@/components/pages/BriefsPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

type Counts = Result<{ all: number; open: number; closed: number }>;
type Thumbs = Result<Map<string, string>>;

const { firstPage, countBriefs, gates } = vi.hoisted(() => ({
  firstPage: vi.fn(),
  countBriefs: vi.fn(),
  gates: {} as {
    counts?: (value: Counts) => void;
    thumbs?: (value: Thumbs) => void;
  },
}));

vi.mock('@/lib/brief-list', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    listBriefsFirstPage: (...args: unknown[]) => firstPage(...args),
    listBriefsPage: vi.fn(),
  };
});
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
  useWorkspaceCapability: (key: string) => key === 'brief.create',
}));
vi.mock('@/lib/use-workspace-data-changed', () => ({ useWorkspaceDataChanged: () => {} }));
vi.mock('@/components/pages/CreateBriefSheet', () => ({ CreateBriefSheet: () => null }));

function brief(id: string, over: Partial<BriefWithThumbnail> = {}): BriefWithThumbnail {
  return {
    id,
    workspace_id: 'w1',
    number: 1,
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

/** The first page resolves at once; its thumbnails wait on gates.thumbs. */
function pageOf(items: BriefWithThumbnail[]) {
  const thumbs = new Promise<Thumbs>((resolve) => {
    gates.thumbs = resolve;
  });
  return { ok: true, data: { items, next: { done: true }, thumbs } };
}

let root: Root | null = null;
const tick = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const skeleton = () => document.querySelector('[data-testid="briefs-skeleton"]');
const cards = () => document.querySelectorAll('[data-brief-card]').length;

async function mount(): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <MemoryRouter initialEntries={['/briefs']}>
        <BriefsPage />
      </MemoryRouter>,
    );
  });
  await tick();
}

beforeEach(() => {
  firstPage.mockReset();
  countBriefs.mockReset().mockImplementation(
    () =>
      new Promise<Counts>((resolve) => {
        gates.counts = resolve;
      }),
  );
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('Briefs first paint', () => {
  it('waits for the counts with the rows in, then paints without waiting for thumbnails', async () => {
    firstPage.mockResolvedValue(pageOf([brief('b1'), brief('b2')]));
    await mount();
    // Rows are in, counts are not: still the skeleton, no zero state.
    expect(skeleton()).not.toBeNull();
    expect(cards()).toBe(0);
    expect(document.body.textContent).not.toContain('show up here');

    await act(async () => gates.counts?.({ ok: true, data: { all: 2, open: 2, closed: 0 } }));
    await tick();
    // Counts landed: the cards and the chip numbers paint together; the
    // thumbnails read is still running.
    expect(skeleton()).toBeNull();
    expect(cards()).toBe(2);
    expect(document.querySelectorAll('[data-brief-tile="icon"]').length).toBe(2);

    // The thumbnails fill the same fixed tile: the card count never changes.
    await act(async () => gates.thumbs?.({ ok: true, data: new Map([['b1', 'v1']]) }));
    await tick();
    expect(cards()).toBe(2);
    expect(document.querySelectorAll('[data-brief-tile="icon"]').length).toBe(1);
  });

  it('one first-page read and one counts read for the first paint', async () => {
    firstPage.mockResolvedValue(pageOf([brief('b1')]));
    await mount();
    await act(async () => gates.counts?.({ ok: true, data: { all: 1, open: 1, closed: 0 } }));
    await tick();
    expect(firstPage).toHaveBeenCalledTimes(1);
    expect(countBriefs).toHaveBeenCalledTimes(1);
  });

  it('a page with a reference-link brief waits for the thumbnails before painting', async () => {
    firstPage.mockResolvedValue(
      pageOf([brief('b1', { reference_links: ['https://example.com/ref'] }), brief('b2')]),
    );
    await mount();
    await act(async () => gates.counts?.({ ok: true, data: { all: 2, open: 2, closed: 0 } }));
    await tick();
    expect(skeleton()).not.toBeNull();
    expect(cards()).toBe(0);

    await act(async () => gates.thumbs?.({ ok: true, data: new Map([['b1', 'v1']]) }));
    await tick();
    expect(skeleton()).toBeNull();
    expect(cards()).toBe(2);
  });
});
