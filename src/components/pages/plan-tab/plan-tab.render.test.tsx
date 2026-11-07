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
vi.mock('@/components/media/Thumbnail', () => ({ Thumbnail: () => null }));

import { PlanTabLoadMore } from '@/components/pages/plan-tab/PlanTabList';
import { ToastProvider } from '@/components/ui/toast';
import {
  PlanSearchResults,
  PlanTabPage,
  itemRoute,
  matchedItemTitle,
} from '@/components/pages/PlanTabPage';
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

/** The page at /plan, This week picked (the default chip) unless `url` says otherwise. */
function render(url = '/plan'): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[url]}>
      <ToastProvider>
        <PlanTabPage />
      </ToastProvider>
    </MemoryRouter>,
  );
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
      expect(html).not.toContain('data-plan-tab-new');
      expect(html).not.toContain('compose-mounted');
    });

    it(`${width}: creators get every plan and New plan; the cards are ListCards in the grid`, () => {
      Object.assign(env, { desktop, side: 'agency', data: DATA, guide: 'off' });
      const html = render();
      expect(html).toContain('data-plan-tab-card="shared"');
      expect(html).toContain('data-plan-tab-card="draft"');
      expect(html).toContain('data-plan-tab-draft');
      expect(html).toContain('data-plan-tab-new');
      expect(html).toContain('compose-mounted');
      // One ListCard per plan (not per post), in LIST_CARD_GRID.
      expect(html.match(/data-list-card=""/g)).toHaveLength(2);
      expect(html).toMatch(/class="grid grid-cols-1 gap-3 md:grid-cols-list-cards"/);
      // The same chips on both widths; no calendar, legend or Month | Week.
      for (const chip of ['bank', 'this', 'next', 'later', 'earlier', 'all']) {
        expect(html).toContain(`data-plan-tab-when="${chip}"`);
      }
      expect(html).not.toContain('data-plan-tab-month');
      expect(html).not.toContain('data-plan-tab-week');
      expect(html).not.toContain('data-plan-tab-view');
      expect(html).not.toContain('data-plan-tab-legend');
      expect(html).not.toContain('data-plan-tab-entry');
      // No visible page title: the tab's top bar is the shared SectionHeader; the
      // only h1 is the sr-only one screen readers and route focus land on.
      expect(html).not.toMatch(/<h1(?![^>]*class="sr-only")/);
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
      expect(html).toContain('data-plan-tab-new');
      Object.assign(env, { side: 'client', guide: 'off' });
      html = render();
      expect(html).toContain('No plans shared yet');
      expect(html).not.toContain('shared with you');
      expect(html).not.toContain('Create plan');
    });

    it(`${width}: the Bank chip shows the Bank's toolbar (search, Filter and sort, Add idea)`, () => {
      Object.assign(env, { desktop, side: 'agency', data: DATA, guide: 'off' });
      const html = render('/plan?week=bank');
      expect(html).toContain('placeholder="Search ideas"');
      expect(html).toContain('data-bank-filter-open');
      expect(html).toContain('data-bank-add-open');
      expect(html).not.toContain('data-plan-tab-new');
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

describe('Plan search results', () => {
  function results(query: string, matched: Record<string, string[]>, bundles = DATA.bundles) {
    return renderToStaticMarkup(
      <MemoryRouter>
        <PlanSearchResults
          bundles={bundles}
          thumbs={DATA.thumbs}
          matchedItems={matched}
          query={query}
          timeZone="UTC"
          now={new Date()}
          onOpenPlan={() => {}}
          onOpenItem={() => {}}
          onClear={() => {}}
        />
      </MemoryRouter>,
    );
  }

  it('lists each plan as its card, with its matched items, the searched words marked', () => {
    const html = results('open', { shared: ['i2'] });
    expect(html).toContain('data-plan-tab-results');
    expect(html).toContain('data-plan-tab-card="draft"');
    expect(html).toContain('data-plan-tab-card="shared"');
    expect(html).toContain('data-plan-tab-match="i2"');
    expect(html).not.toContain('data-plan-tab-match="i1"');
    expect(html).toMatch(/<mark[^>]*data-search-mark=""[^>]*>Open<\/mark>/);
    // A matched item row is a full-height (44px) tappable row.
    expect(html).toMatch(
      /<button[^>]*min-h-11[^>]*data-plan-tab-match="i2"|data-plan-tab-match="i2"[^>]*min-h-11/,
    );
  });

  it('zero matches: the shared NoResults line, never an "empty" state', () => {
    const html = results('zz', {}, []);
    expect(html).toContain('Try another word for &quot;zz&quot;.');
    expect(html).not.toMatch(/empty|No matches|Nothing/i);
  });

  it('an item opens in its plan', () => {
    expect(itemRoute('shared', 'i2')).toBe('/plan/shared?item=i2');
    expect(matchedItemTitle(DATA.bundles[1] as PlanBundle, 'i2')).toBe('Open idea');
    expect(matchedItemTitle(DATA.bundles[1] as PlanBundle, 'gone')).toBeNull();
  });
});
