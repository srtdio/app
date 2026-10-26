import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { PlanBundle, PlanItemRow, PlanRow } from '@/lib/chat/plans';
import type { PlanTabData } from '@/lib/plan-tab-read';

// The page with its reads and its sheets stubbed: the viewer's side, the
// width and the tab's data are set per test, so the markup is exactly what
// each side gets (no portals in the unit env).
const env = vi.hoisted(() => ({
  desktop: true,
  side: 'agency' as 'agency' | 'client',
  guide: 'off' as 'off' | 'step',
  data: null as PlanTabData | null,
}));
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => env.desktop,
}));
vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: 'ws', workspaces: [{ id: 'ws', timezone: 'UTC' }] }),
}));
vi.mock('@/lib/chat/viewer-role', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat/viewer-role')>()),
  useViewerSide: () => ({ side: env.side, ready: true }),
}));
vi.mock('@/components/induction/InductionProvider', () => ({
  useInduction: () => ({ resolution: { kind: env.guide } }),
}));
vi.mock('@/components/pages/plan-tab/use-plan-tab-data', () => ({
  usePlanTabData: () => ({
    load:
      env.data !== null ? { status: 'ready', data: env.data } : { status: 'loading', data: null },
    reload: async () => {},
    retry: () => {},
  }),
}));
vi.mock('@/components/chat/PlanComposeScreen', () => ({
  PlanComposeScreen: () => <div>compose-mounted</div>,
}));
vi.mock('@/components/pages/plan-tab/PlanTabAdd', () => ({ PlanTabAdd: () => null }));
vi.mock('@/components/chat/PlanMoveSheet', () => ({ PlanKeepApprovalSheet: () => null }));
vi.mock('@/components/media/Thumbnail', () => ({ Thumbnail: () => null }));

import { setPlanTabMore } from '@/components/pages/plan-tab/plan-tab-more';
import { ToastProvider } from '@/components/ui/toast';
import { PlanTabPage, entryRoute } from '@/components/pages/PlanTabPage';
import { civilToday } from '@/lib/plan-week';

const TODAY = civilToday(new Date(), 'UTC');

function plan(id: string, title: string, audience: 'team' | 'client'): PlanRow {
  return {
    id,
    workspace_id: 'ws',
    title,
    starts_on: TODAY,
    ends_on: TODAY,
    audience,
    created_by: null,
  };
}

function concept(id: string, planId: string, title: string): PlanItemRow {
  return {
    id,
    plan_id: planId,
    kind: 'concept',
    position: 0,
    title,
    description: null,
    post_id: null,
    created_at: '2026-10-01T00:00:00Z',
    target_date: TODAY,
  };
}

const bundle = (row: PlanRow, items: PlanItemRow[]): PlanBundle => ({
  plan: row,
  items,
  reviews: [],
  postStages: {},
  postInfo: {},
});

const DATA: PlanTabData = {
  bundles: [
    bundle(plan('draft', 'Secret drafts', 'team'), [concept('i1', 'draft', 'Hidden idea')]),
    bundle(plan('shared', 'Shared week', 'client'), [concept('i2', 'shared', 'Open idea')]),
  ],
  posts: [],
  thumbs: { posts: {}, concepts: {} },
  anyPlan: true,
  timeZone: 'UTC',
  nextCursor: null,
};

function render(): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={['/plan']}>
      <ToastProvider>
        <PlanTabPage />
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('PlanTabPage', () => {
  it('approvers never see drafts, Create, drag or the day menu (laptop)', () => {
    Object.assign(env, { desktop: true, side: 'client', data: DATA });
    const html = render();
    expect(html).toContain('Shared week');
    expect(html).toContain('Open idea');
    expect(html).not.toContain('Secret drafts');
    expect(html).not.toContain('Hidden idea');
    expect(html).not.toContain('data-plan-tab-draft');
    expect(html).not.toContain('data-plan-tab-new');
    expect(html).not.toContain('compose-mounted');
    expect(html).not.toContain('data-plan-tab-draggable');
    expect(html).not.toContain('data-plan-tab-addable');
  });

  it('creators get every plan, New plan, drag and the day menu (laptop)', () => {
    Object.assign(env, { desktop: true, side: 'agency', data: DATA });
    const html = render();
    expect(html).toContain('Secret drafts');
    expect(html).toContain('data-plan-tab-draft');
    expect(html).toContain('data-plan-tab-new');
    expect(html).toContain('compose-mounted');
    expect(html).toContain('data-plan-tab-draggable');
    expect(html).toContain('data-plan-tab-addable');
    expect(html).toContain('Month');
    expect(html).toContain('Plan item, in its plan&#x27;s colour');
    // No page title: the tab's top bar is the shared SectionHeader.
    expect(html).not.toContain('<h1');
  });

  it('approvers on a phone: shared plans only, no New plan', () => {
    Object.assign(env, { desktop: false, side: 'client', data: DATA });
    const html = render();
    expect(html).toContain('data-plan-tab-card="shared"');
    expect(html).not.toContain('data-plan-tab-card="draft"');
    expect(html).not.toContain('data-plan-tab-new');
  });

  it('phone: Load more ends the list while more plans remain; Loading while busy; none when all are in', () => {
    Object.assign(env, { desktop: false, side: 'agency', data: DATA });
    expect(render()).not.toContain('data-plan-tab-more');
    setPlanTabMore({ busy: false, onMore: () => {} });
    let html = render();
    expect(html).toContain('data-plan-tab-more');
    expect(html).toContain('>Load more</button>');
    // The control comes after the last card.
    expect(html.indexOf('data-plan-tab-more')).toBeGreaterThan(
      html.lastIndexOf('data-plan-tab-card'),
    );
    // The shared Button: 44 tall, tokens only.
    expect(html).toMatch(/<button class="[^"]*min-h-\[44px\][^"]*"[^>]*data-plan-tab-more=""/);
    setPlanTabMore({ busy: true, onMore: () => {} });
    html = render();
    expect(html).toContain('>Loading</button>');
    expect(html).toContain('data-plan-tab-more="" disabled=""');
    setPlanTabMore(null);
    expect(render()).not.toContain('data-plan-tab-more');
  });

  it('the zero state: line 2 until onboarding is done; no create button of its own', () => {
    const none: PlanTabData = { ...DATA, bundles: [], anyPlan: false };
    Object.assign(env, { desktop: true, side: 'agency', data: none, guide: 'step' });
    let html = render();
    expect(html).toContain('No plans yet');
    expect(html).toContain('Plan the content together, week by week');
    // The top bar's New plan is the only create control on an empty page.
    expect(html).not.toContain('Create plan');
    expect(html).toContain('data-plan-tab-new');
    Object.assign(env, { side: 'client', guide: 'off' });
    html = render();
    expect(html).toContain('No plans shared yet');
    expect(html).not.toContain('shared with you');
    expect(html).not.toContain('Create plan');
  });

  it('opens an item in its plan and a loose post on its page', () => {
    const b = DATA.bundles[1] as PlanBundle;
    const it0 = b.items[0] as PlanItemRow;
    expect(
      entryRoute({
        kind: 'item',
        key: 'k',
        day: TODAY,
        title: '',
        tone: 'accent',
        bundle: b,
        item: it0,
      }),
    ).toBe('/plan/shared?item=i2');
    expect(
      entryRoute({
        kind: 'post',
        key: 'p',
        day: TODAY,
        title: '',
        post: { id: 'p1', title: '', stage: 'review', target_date: null },
      }),
    ).toBe('/posts/p1');
  });
});
