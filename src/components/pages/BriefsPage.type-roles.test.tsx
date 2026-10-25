// @vitest-environment jsdom
// Type roles on the Briefs list (design rules, 24 Oct 2026): the time-group
// heading is the section label (sm/600 uppercase tracking-[0.06em] fg-2), a
// card title is base/500, the objective is base fg-2 secondary copy, and the
// due line is sm fg-3 meta. Mocks mirror BriefsPage.w5-list.test.tsx.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BriefWithThumbnail } from '@srtdio/briefs';
import { BriefsPage } from '@/components/pages/BriefsPage';
import { briefDueLabel } from '@/components/pages/BriefCard';

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

const { listBriefs } = vi.hoisted(() => ({ listBriefs: vi.fn() }));

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
  useWorkspaceCapability: (key: string) => key === 'brief.create',
}));
vi.mock('@/lib/use-workspace-data-changed', () => ({ useWorkspaceDataChanged: () => {} }));
vi.mock('@/components/pages/CreateBriefSheet', () => ({ CreateBriefSheet: () => null }));

const TARGET_DATE = '2026-12-01';

function brief(over: Partial<BriefWithThumbnail> = {}): BriefWithThumbnail {
  return {
    id: 'b1',
    workspace_id: 'w1',
    number: 1,
    title: 'Launch reel',
    objective: 'Build hype for the drop',
    legacy_author_name: null,
    status: 'open',
    target_date: TARGET_DATE,
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

async function mount() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <MemoryRouter initialEntries={['/briefs']}>
        <Routes>
          <Route path="/briefs" element={<BriefsPage />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  await act(async () => new Promise((r) => setTimeout(r, 0)));
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
  listBriefs.mockReset().mockResolvedValue({ ok: true, data: [brief()] });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('Briefs list type roles', () => {
  it('the time-group heading is the section label', async () => {
    await mount();
    const label = byText('This week');
    expect(label.tagName).toBe('H3');
    expectRole(label, ['text-sm', 'font-semibold', 'uppercase', 'tracking-[0.06em]', 'text-fg-2']);
  });

  it('the card title is base/500 and the objective is base fg-2', async () => {
    await mount();
    expectRole(byText('Launch reel'), ['text-base', 'font-medium', 'text-fg']);
    expectRole(byText('Build hype for the drop'), ['text-base', 'text-fg-2']);
  });

  it('the due line is sm fg-3 meta', async () => {
    await mount();
    const due = byText(briefDueLabel(TARGET_DATE, 'UTC'));
    const meta = due.parentElement;
    expect(meta).not.toBeNull();
    expectRole(meta as HTMLElement, ['text-sm', 'text-fg-3']);
  });

  it('no arbitrary pixel sizes or bold weights in the rendered list', async () => {
    await mount();
    const html = document.body.innerHTML;
    expect(html).not.toMatch(/text-\[\d+(\.\d+)?px\]/);
    expect(html).not.toMatch(/text-legacy-/);
    expect(html).not.toContain('font-bold');
  });
});
