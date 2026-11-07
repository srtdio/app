import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
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
  // What the page last published into the app top bar (useTopbarActions).
  topbar: null as { sort?: ReactNode; primary?: ReactNode } | null,
}));
vi.mock('@/components/shell/topbar-actions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/shell/topbar-actions')>()),
  useTopbarActions: (actions: { sort?: ReactNode; primary?: ReactNode }) => {
    env.topbar = actions;
  },
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
vi.mock('@/components/media/Thumbnail', () => ({ Thumbnail: () => null }));

import { PlanTabLoadMore } from '@/components/pages/plan-tab/PlanTabList';
import { ToastProvider } from '@/components/ui/toast';
import { PlanTabPage } from '@/components/pages/PlanTabPage';
import { civilToday } from '@/lib/plan-week';

const TODAY = civilToday(new Date(), 'UTC');

function plan(
  id: string,
  title: string,
  audience: 'team' | 'client',
  day: string = TODAY,
): PlanRow {
  return {
    id,
    workspace_id: 'ws',
    title,
    starts_on: day,
    ends_on: day,
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

/** The page at /plan, Upcoming picked (the default chip) unless `url` says otherwise. */
function render(url = '/plan'): string {
  env.topbar = null;
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[url]}>
      <ToastProvider>
        <PlanTabPage />
      </ToastProvider>
    </MemoryRouter>,
  );
}

/** The markup of what the page published into the top bar: its sort, then its "+". */
function topbar(): { sort: string; primary: string } {
  const node = (n: ReactNode): string =>
    n === undefined || n === null ? '' : renderToStaticMarkup(<MemoryRouter>{n}</MemoryRouter>);
  return { sort: node(env.topbar?.sort), primary: node(env.topbar?.primary) };
}

/** Where each chip sits in the markup (-1: not shown). */
function chipAt(html: string, chip: string): number {
  return html.indexOf(`data-plan-tab-when="${chip}"`);
}

describe('PlanTabPage', () => {
  for (const desktop of [false, true]) {
    const width = desktop ? 'laptop' : 'phone';

    it(`${width}: approvers see shared plans only, no Draft and no New plan`, () => {
      Object.assign(env, { desktop, side: 'client', data: DATA, guide: 'off' });
      const html = render();
      expect(html).toContain('data-plan-tab-card="shared"');
      expect(html).toContain('Shared week');
      expect(html).not.toContain('data-plan-tab-card="draft"');
      expect(html).not.toContain('Secret drafts');
      expect(html).not.toContain('data-plan-tab-draft');
      expect(html).not.toContain('compose-mounted');
      // The top bar: the sort, and no "+" for anyone who can't create.
      const bar = topbar();
      expect(bar.sort).toContain('aria-label="Sort plans"');
      expect(bar.primary).toBe('');
      expect(html).not.toContain('data-topbar-plus');
    });

    it(`${width}: creators get every plan and New plan; the cards are ListCards in the grid`, () => {
      Object.assign(env, { desktop, side: 'agency', data: DATA, guide: 'off' });
      const html = render();
      expect(html).toContain('data-plan-tab-card="shared"');
      expect(html).toContain('data-plan-tab-card="draft"');
      expect(html).toContain('data-plan-tab-draft');
      expect(html).toContain('compose-mounted');
      // One ListCard per plan (not per post), in LIST_CARD_GRID.
      expect(html.match(/data-list-card=""/g)).toHaveLength(2);
      expect(html).toMatch(/class="grid grid-cols-1 md:grid-cols-list-cards md:gap-x-6"/);
      // The same chips on both widths, Bank, Upcoming, Past in that order; no
      // calendar, legend or Month | Week.
      expect(chipAt(html, 'bank')).toBeGreaterThan(-1);
      expect(chipAt(html, 'bank')).toBeLessThan(chipAt(html, 'upcoming'));
      expect(chipAt(html, 'upcoming')).toBeLessThan(chipAt(html, 'past'));
      for (const old of ['this', 'next', 'later', 'earlier', 'all']) {
        expect(html).not.toContain(`data-plan-tab-when="${old}"`);
      }
      expect(html).not.toContain('data-plan-tab-month');
      expect(html).not.toContain('data-plan-tab-week');
      expect(html).not.toContain('data-plan-tab-view');
      expect(html).not.toContain('data-plan-tab-legend');
      expect(html).not.toContain('data-plan-tab-entry');
      // No visible page title; the only h1 is the sr-only one screen readers
      // and route focus land on. No search field of its own.
      expect(html).not.toMatch(/<h1(?![^>]*class="sr-only")/);
      expect(html).not.toContain('Search plans');
      expect(html).not.toContain('type="search"');
    });

    it(`${width}: creators get the top bar's sort and New plan (the filled +), not in the page`, () => {
      Object.assign(env, { desktop, side: 'agency', data: DATA, guide: 'off' });
      const html = render();
      const bar = topbar();
      expect(bar.sort).toContain('aria-label="Sort plans"');
      expect(bar.primary).toContain('data-topbar-plus=""');
      expect(bar.primary).toContain('aria-label="New plan"');
      expect(html).not.toContain('data-topbar-plus');
      // The plan list has no select mode: no Select on its chip row.
      expect(html).not.toContain('data-section-select');
    });

    it(`${width}: Upcoming (the default) groups This week under its heading; Past holds the rest`, () => {
      const past = bundle(plan('old', 'Old week', 'client', '2020-01-06'), []);
      const withPast: PlanTabData = { ...DATA, bundles: [...DATA.bundles, past] };
      Object.assign(env, { desktop, side: 'agency', data: withPast, guide: 'off' });
      let html = render();
      expect(html).toMatch(
        /aria-pressed="true"[^>]*data-plan-tab-when="upcoming"|data-plan-tab-when="upcoming"[^>]*aria-pressed="true"/,
      );
      expect(html).toContain('data-plan-tab-section="this"');
      expect(html).toContain('>This week</h2>');
      expect(html).toContain('data-plan-tab-card="shared"');
      expect(html).not.toContain('data-plan-tab-card="old"');
      html = render('/plan?week=past');
      expect(html).toContain('data-plan-tab-card="old"');
      expect(html).not.toContain('data-plan-tab-card="shared"');
      expect(html).toContain('data-plan-tab-section="earlier"');
      expect(html).not.toMatch(/<h2[^>]*>Past<\/h2>/);
    });

    it(`${width}: a retired chip in the URL lands on Upcoming or Past`, () => {
      const past = bundle(plan('old', 'Old week', 'client', '2020-01-06'), []);
      Object.assign(env, {
        desktop,
        side: 'agency',
        data: { ...DATA, bundles: [...DATA.bundles, past] },
        guide: 'off',
      });
      for (const old of ['this', 'next', 'later', 'all']) {
        expect(render(`/plan?week=${old}`)).toContain('data-plan-tab-card="shared"');
      }
      const html = render('/plan?week=earlier');
      expect(html).toContain('data-plan-tab-card="old"');
      expect(html).not.toContain('data-plan-tab-card="shared"');
    });

    it(`${width}: Load more ends the list while more plans remain; busy keeps the label; none when all are in`, () => {
      Object.assign(env, { desktop, side: 'agency', data: DATA, moreBusy: false });
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
      expect(html).toMatch(/<button class="[^"]*min-h-11[^"]*"[^>]*data-plan-tab-load-more=""/);
      env.moreBusy = true;
      html = render();
      expect(html).toMatch(/data-plan-tab-load-more="" disabled="" aria-busy="true"[^]*?Load more/);
      env.moreBusy = false;
      env.data = DATA;
      expect(render()).not.toContain('data-plan-tab-load-more');
    });

    it(`${width}: the zero state: line 2 until onboarding is done; no create button of its own`, () => {
      const none: PlanTabData = { ...DATA, bundles: [], anyPlan: false };
      Object.assign(env, { desktop, side: 'agency', data: none, guide: 'step' });
      let html = render();
      expect(html).toContain('No plans yet');
      expect(html).toContain('Plan the content together, week by week');
      // The top bar's New plan is the only create control on an empty page.
      expect(html).not.toContain('Create plan');
      expect(topbar().primary).toContain('aria-label="New plan"');
      Object.assign(env, { side: 'client', guide: 'off' });
      html = render();
      expect(html).toContain('No plans shared yet');
      expect(html).not.toContain('shared with you');
      expect(html).not.toContain('Create plan');
    });

    it(`${width}: a client on the Bank: Filter and sort, no Add idea, no Select`, () => {
      Object.assign(env, { desktop, side: 'client', data: DATA, guide: 'off' });
      const html = render('/plan?week=bank');
      const bar = topbar();
      expect(bar.sort).toContain('data-bank-filter-open');
      expect(bar.primary).toBe('');
      expect(html).not.toContain('data-section-select');
    });

    it(`${width}: the Bank chip publishes Filter and sort (IconSort) and Add idea; Select on its chip row`, () => {
      Object.assign(env, { desktop, side: 'agency', data: DATA, guide: 'off' });
      const html = render('/plan?week=bank');
      const bar = topbar();
      expect(bar.sort).toContain('data-bank-filter-open');
      expect(bar.sort).toContain('aria-label="Filter and sort"');
      expect(bar.primary).toContain('aria-label="Add idea"');
      expect(bar.primary).not.toContain('New plan');
      // No search of its own.
      expect(html).not.toContain('Search ideas');
      // The visible Select at the chip row's end, off until tapped.
      expect(html).toContain('data-chip-row-select');
      expect(html).toContain('data-section-select="off"');
      // The side panel, its Expand and the table are gone.
      expect(html).not.toContain('data-bank-expand');
      expect(html).not.toContain('data-bank-table');
    });
  }

  it("Load more: the tap is the hook's loadMore; its label follows busy", () => {
    const onMore = vi.fn();
    const el = PlanTabLoadMore({ more: { busy: false, onMore } });
    const props = el.props as { onClick: () => void; busy: boolean; children: string };
    props.onClick();
    expect(onMore).toHaveBeenCalledTimes(1);
    expect(props.busy).toBe(false);
    expect(props.children).toBe('Load more');
    // Busy keeps the label (Button busy), never a 'Loading' swap.
    const busy = PlanTabLoadMore({ more: { busy: true, onMore } }).props as {
      busy: boolean;
      children: string;
    };
    expect(busy.busy).toBe(true);
    expect(busy.children).toBe('Load more');
  });
});
