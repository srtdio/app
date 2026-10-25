// @vitest-environment jsdom
// Type roles on Brief detail (design rules, 24 Oct 2026): the brief title is
// the page title (3xl/600 tracking-tight), the top bar status line is the
// screen header (lg/600), section labels are sm/600 uppercase
// tracking-[0.06em] fg-2, and the brief text is base fg body. Mocks mirror
// BriefDetailPage.w5-detail.test.tsx.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, ToastViewport } from '@/components/ui/toast';
import { BriefDetailPage, CLOSED_BRIEF_LINE } from '@/components/pages/BriefDetailPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  getBrief: vi.fn(),
  getBriefGallery: vi.fn(),
  listPosts: vi.fn(),
}));

vi.mock('@srtdio/briefs', () => ({
  getBrief: (...args: unknown[]) => h.getBrief(...args),
  getBriefGallery: (...args: unknown[]) => h.getBriefGallery(...args),
  reopenBrief: vi.fn(),
}));
vi.mock('@srtdio/rpc', () => ({ briefClose: vi.fn() }));
vi.mock('@srtdio/posts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@srtdio/posts')>()),
  listPosts: (...args: unknown[]) => h.listPosts(...args),
}));
vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: null } }) } },
}));
vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => () => 'trace-1' }));
vi.mock('@/lib/session-context', () => ({
  useSession: () => ({ session: { user: { id: 'u1' } } }),
}));
vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: () => ({
    workspaceId: 'w1',
    workspaceKey: 'ACME',
    workspaces: [{ id: 'w1', timezone: 'UTC', week_start_day: 1 }],
  }),
}));
vi.mock('@/lib/workspace-context-capability', () => ({
  useWorkspaceCapability: () => false,
}));
vi.mock('@/components/pages/pcs/use-post-members', () => ({
  usePostMembers: () => ({
    options: [{ userId: 'u1', displayName: 'Asha Rao' }],
    loading: false,
    error: null,
  }),
}));
vi.mock('@/lib/use-is-laptop', () => ({ useIsLaptop: () => false }));
vi.mock('@/components/comments/Comments', () => ({ Comments: () => <div>comments</div> }));
vi.mock('@/components/pages/pcs/PostGallery', () => ({ PostGallery: () => <div>gallery</div> }));

function detail(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    data: {
      linked_posts_count: 0,
      brief: {
        id: 'b1',
        workspace_id: 'w1',
        number: 3,
        title: 'Festive drop',
        objective: 'Build hype for the drop',
        brand_requirements: 'Gold logo only',
        legacy_author_name: null,
        status: 'open',
        target_date: null,
        reference_links: null,
        mentions: null,
        format_requested: null,
        closed_at: null,
        closed_by: null,
        created_by: 'u1',
        created_via: 'manual',
        created_at: '2026-10-01T10:00:00Z',
        updated_at: '2026-10-01T10:00:00Z',
        deleted_at: null,
        row_version: 1,
        ...over,
      },
    },
  };
}

let root: Root | null = null;

async function mount() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <ToastProvider>
        <MemoryRouter initialEntries={['/briefs/b1']}>
          <Routes>
            <Route path="/briefs/:briefId" element={<BriefDetailPage />} />
          </Routes>
        </MemoryRouter>
        <ToastViewport />
      </ToastProvider>,
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

const SECTION_LABEL = ['text-sm', 'font-semibold', 'uppercase', 'tracking-[0.06em]', 'text-fg-2'];

beforeEach(() => {
  h.getBrief.mockReset().mockResolvedValue(detail());
  h.getBriefGallery.mockReset().mockResolvedValue({ ok: true, data: [] });
  h.listPosts.mockReset().mockResolvedValue({ ok: true, data: [] });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('Brief detail type roles', () => {
  it('the brief title is the page title: 3xl/600 tracking-tight, no leading override', async () => {
    await mount();
    const titles = document.querySelectorAll('h1');
    expect(titles).toHaveLength(1);
    const title = titles[0]!;
    expect(title.textContent).toContain('Festive drop');
    expectRole(title, ['text-3xl', 'font-semibold', 'tracking-tight', 'text-fg']);
    expect(title.className).not.toMatch(/\bleading-/);
    expect(title.className).not.toContain('font-bold');
  });

  it('the top bar status line is the screen header (lg/600)', async () => {
    await mount();
    const status = document.querySelector('[data-brief-status]')?.parentElement;
    expect(status).toBeTruthy();
    expectRole(status as HTMLElement, ['text-lg', 'font-semibold']);
  });

  it('Objective and Brand requirements are section labels', async () => {
    await mount();
    expectRole(byText('Objective'), SECTION_LABEL);
    expectRole(byText('Brand requirements'), SECTION_LABEL);
  });

  it('the brief text is base fg body', async () => {
    await mount();
    expectRole(byText('Build hype for the drop'), ['text-base', 'text-fg']);
    expectRole(byText('Gold logo only'), ['text-base', 'text-fg']);
  });

  it('a closed brief says so in base fg-2 secondary copy', async () => {
    h.getBrief.mockResolvedValue(detail({ status: 'closed', closed_at: '2026-10-02T10:00:00Z' }));
    await mount();
    const line = [...document.querySelectorAll('p')].find(
      (p) => p.textContent === CLOSED_BRIEF_LINE,
    );
    expect(line).toBeDefined();
    expectRole(line as HTMLElement, ['text-base', 'text-fg-2']);
  });
});
