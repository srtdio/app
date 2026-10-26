// @vitest-environment jsdom
// Briefs tab return, page level: the list this session kept (every page the
// person loaded, thumbnails filled) and the chip counts paint on the first
// render at any age, with no skeleton, then refresh quietly: the refresh lands
// only while the page is untouched, a failed one keeps the kept view, and Load
// more updates the kept list instead of dropping it.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BriefWithThumbnail } from '@srtdio/briefs';
import { BriefsPage } from '@/components/pages/BriefsPage';
import { keptBriefsList } from '@/lib/brief-list-shared';
import { setPrefetchContext } from '@/lib/prefetch-context';
import { READ_FRESH_MS, resetSessionReads } from '@/lib/session-read';

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

const { firstPage, nextPage, countBriefs } = vi.hoisted(() => ({
  firstPage: vi.fn(),
  nextPage: vi.fn(),
  countBriefs: vi.fn(),
}));

vi.mock('@/lib/brief-list', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    listBriefsFirstPage: (...args: unknown[]) => firstPage(...args),
    listBriefsPage: (...args: unknown[]) => nextPage(...args),
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

function brief(id: string, createdAt: string): BriefWithThumbnail {
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
    created_at: createdAt,
    updated_at: createdAt,
    deleted_at: null,
    row_version: 1,
    thumbnailAssetVersionId: null,
  };
}

const B1 = brief('b1', '2026-10-25T09:00:00Z');
const B2 = brief('b2', '2026-10-24T09:00:00Z');
const B3 = brief('b3', '2026-10-26T09:00:00Z');

function pageOf(items: BriefWithThumbnail[], next: unknown = { done: true }) {
  return {
    ok: true,
    data: { items, next, thumbs: Promise.resolve({ ok: true, data: new Map<string, string>() }) },
  };
}

let root: Root | null = null;
const tick = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const skeleton = () => document.querySelector('[data-testid="briefs-skeleton"]');
const text = () => document.body.textContent ?? '';
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === label,
  );

function holdNextRead(): (value: unknown) => void {
  let land: (value: unknown) => void = () => {};
  firstPage.mockImplementationOnce(
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
      <MemoryRouter initialEntries={['/briefs']}>
        <BriefsPage />
      </MemoryRouter>,
    );
  });
  await tick();
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
  // The shell keys the shared reads to this user and workspace.
  setPrefetchContext({ userId: 'u1', workspaceId: 'w1' });
  firstPage.mockReset();
  nextPage.mockReset();
  countBriefs.mockReset().mockResolvedValue({ ok: true, data: { all: 2, open: 2, closed: 0 } });
});

afterEach(() => {
  leave();
  setPrefetchContext(null);
  resetSessionReads();
  vi.useRealTimers();
});

describe('Briefs tab return', () => {
  it('past the window: the kept cards paint at once, then the quiet refresh lands', async () => {
    firstPage.mockResolvedValue(pageOf([B1]));
    await visit();
    expect(text()).toContain('Brief b1');
    leave();
    vi.setSystemTime(Date.now() + READ_FRESH_MS + 1_000);
    const land = holdNextRead();
    await visit();
    expect(skeleton()).toBeNull();
    expect(text()).toContain('Brief b1');
    await act(async () => land(pageOf([B3, B1])));
    await tick();
    expect(text()).toContain('Brief b3');
    expect(firstPage).toHaveBeenCalledTimes(2);
  });

  it('a refresh that lands after a touch is held for the next visit', async () => {
    firstPage.mockResolvedValue(pageOf([B1]));
    await visit();
    leave();
    vi.setSystemTime(Date.now() + READ_FRESH_MS + 1_000);
    const land = holdNextRead();
    await visit();
    act(() => {
      window.dispatchEvent(new Event('pointerdown'));
    });
    await act(async () => land(pageOf([B3, B1])));
    await tick();
    expect(text()).not.toContain('Brief b3');
    expect(keptBriefsList('u1', 'w1')?.items.map((b) => b.id)).toEqual(['b3', 'b1']);
    leave();
    await visit();
    expect(skeleton()).toBeNull();
    expect(text()).toContain('Brief b3');
  });

  it('a failed quiet refresh keeps the kept cards, with no load error', async () => {
    firstPage.mockResolvedValue(pageOf([B1]));
    await visit();
    leave();
    vi.setSystemTime(Date.now() + READ_FRESH_MS + 1_000);
    firstPage.mockResolvedValue({ ok: false, error: { code: 'unknown', message: 'boom' } });
    await visit();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(text()).toContain('Brief b1');
  });

  it('Load more keeps every loaded page, so a return paints them all', async () => {
    const cursor = { createdAt: B1.created_at, id: 'b1' };
    firstPage.mockResolvedValue(pageOf([B1], { done: false, cursor }));
    nextPage.mockResolvedValue({ ok: true, data: { items: [B2], next: { done: true } } });
    await visit();
    await act(async () => button('Load more')?.click());
    await tick();
    expect(keptBriefsList('u1', 'w1')?.items.map((b) => b.id)).toEqual(['b1', 'b2']);
    leave();
    await visit();
    expect(skeleton()).toBeNull();
    expect(text()).toContain('Brief b1');
    expect(text()).toContain('Brief b2');
    expect(button('Load more')).toBeUndefined();
  });
});
