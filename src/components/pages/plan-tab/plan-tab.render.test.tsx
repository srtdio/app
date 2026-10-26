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
  moreBusy: false,
  loadMore: (): void => {},
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
vi.mock('@/lib/session-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/session-context')>()),
  useSession: () => ({ session: { user: { id: 'u1' } } }),
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
    loadMore: env.loadMore,
    moreBusy: env.moreBusy,
  }),
}));
vi.mock('@/components/chat/PlanComposeScreen', () => ({
  PlanComposeScreen: () => <div>compose-mounted</div>,
}));
vi.mock('@/components/pages/plan-tab/PlanTabAdd', () => ({ PlanTabAdd: () => null }));
vi.mock('@/components/chat/PlanMoveSheet', () => ({ PlanKeepApprovalSheet: () => null }));
vi.mock('@/components/media/Thumbnail', () => ({ Thumbnail: () => null }));

import { PlanTabLoadMore } from '@/components/pages/plan-tab/PlanTabList';
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
    Object.assign(env, { desktop: false, side: 'agency', data: DATA, moreBusy: false });
    expect(render()).not.toContain('data-plan-tab-load-more');
    env.data = { ...DATA, nextCursor: { startsOn: TODAY, id: 'draft' } };
    let html = render();
    expect(html).toContain('data-plan-tab-load-more');
    expect(html).toContain('>Load more</button>');
    // The control comes after the last card.
    expect(html.indexOf('data-plan-tab-load-more')).toBeGreaterThan(
      html.lastIndexOf('data-plan-tab-card'),
    );
    // The shared Button: 44 tall, tokens only.
    expect(html).toMatch(/<button class="[^"]*min-h-\[44px\][^"]*"[^>]*data-plan-tab-load-more=""/);
    env.moreBusy = true;
    html = render();
    expect(html).toContain('>Loading</button>');
    expect(html).toContain('data-plan-tab-load-more="" disabled=""');
    env.moreBusy = false;
    env.data = DATA;
    expect(render()).not.toContain('data-plan-tab-load-more');
  });

  it('laptop: 13 plans in range show 12 and Load more under the calendar; after the tap 13 and no control', () => {
    const many = (n: number): PlanBundle[] =>
      Array.from({ length: n }, (_, k) =>
        bundle(plan(`p${String(k).padStart(2, '0')}`, `Plan ${k + 1}`, 'client'), []),
      );
    const first: PlanTabData = {
      ...DATA,
      bundles: many(12),
      nextCursor: { startsOn: TODAY, id: 'p00' },
    };
    Object.assign(env, { desktop: true, side: 'agency', data: first, moreBusy: false });
    let html = render();
    expect(html.match(/data-plan-tab-chip="p\d\d"/g)).toHaveLength(12);
    expect(html).toContain('>Load more</button>');
    expect(html).toMatch(/<button class="[^"]*min-h-\[44px\][^"]*"[^>]*data-plan-tab-load-more=""/);
    // At the end of the laptop view: after the grid.
    expect(html.indexOf('data-plan-tab-load-more')).toBeGreaterThan(
      html.indexOf('data-plan-tab-month'),
    );
    env.moreBusy = true;
    html = render();
    expect(html).toContain('data-plan-tab-load-more="" disabled=""');
    expect(html).toContain('>Loading</button>');
    // The tap's page landed: every plan, no cursor, no control.
    Object.assign(env, {
      moreBusy: false,
      data: { ...first, bundles: many(13), nextCursor: null },
    });
    html = render();
    expect(html.match(/data-plan-tab-chip="p\d\d"/g)).toHaveLength(13);
    expect(html).not.toContain('data-plan-tab-load-more');
  });

  it("Load more: the tap is the hook's loadMore; its label follows busy", () => {
    const onMore = vi.fn();
    const el = PlanTabLoadMore({ more: { busy: false, onMore } });
    const props = el.props as { onClick: () => void; disabled: boolean; children: string };
    props.onClick();
    expect(onMore).toHaveBeenCalledTimes(1);
    expect(props.disabled).toBe(false);
    expect(props.children).toBe('Load more');
    const busy = PlanTabLoadMore({ more: { busy: true, onMore } }).props as {
      disabled: boolean;
      children: string;
    };
    expect(busy.disabled).toBe(true);
    expect(busy.children).toBe('Loading');
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
