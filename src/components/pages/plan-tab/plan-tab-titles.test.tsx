import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import type { PlanBundle, PlanItemRow, PlanRow } from '@/lib/chat/plans';

// How plan titles wrap on each Plan tab surface: phone cards, week cards and
// the empty-day menu rows take up to two lines, then an ellipsis; chips and
// month rows stay on one line with an ellipsis. Plus the toolbar arrows'
// hidden names in each view.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/components/chat/PlanMoveSheet', () => ({ PlanKeepApprovalSheet: () => null }));
vi.mock('@/components/media/Thumbnail', () => ({ Thumbnail: () => null }));

import { PlanCardTop } from '@/components/chat/PlanCard';
import { ToastProvider } from '@/components/ui/toast';
import { PlanCalendar } from '@/components/pages/plan-tab/PlanCalendar';
import { PlanDayMenu } from '@/components/pages/plan-tab/PlanDayMenu';
import { PlanTabCard } from '@/components/pages/plan-tab/PlanTabList';
import type { PlanTabView } from '@/lib/plan-tab';
import { civilToday } from '@/lib/plan-week';

const TODAY = civilToday(new Date(), 'UTC');
const PLAN_TITLE = 'A very long festive season launch plan title';
const ITEM_TITLE = 'A very long concept title that needs two lines';

const PLAN: PlanRow = {
  id: 'p1',
  workspace_id: 'ws',
  title: PLAN_TITLE,
  starts_on: TODAY,
  ends_on: TODAY,
  audience: 'client',
  created_by: null,
};

const ITEM: PlanItemRow = {
  id: 'i1',
  plan_id: 'p1',
  kind: 'concept',
  position: 0,
  title: ITEM_TITLE,
  description: null,
  post_id: null,
  created_at: '2026-10-01T00:00:00Z',
  target_date: TODAY,
};

const BUNDLE: PlanBundle = {
  plan: PLAN,
  items: [ITEM],
  reviews: [],
  postStages: {},
  postInfo: {},
};

const wrap = (node: ReactElement): string =>
  renderToStaticMarkup(
    <MemoryRouter>
      <ToastProvider>{node}</ToastProvider>
    </MemoryRouter>,
  );

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The class lists of every element whose own text is exactly `text`. */
function classesOf(html: string, text: string): string[] {
  const re = new RegExp(`<\\w+[^>]*class="([^"]*)"[^>]*>${escape(text)}</`, 'g');
  return [...html.matchAll(re)].map((m) => m[1] ?? '');
}

function calendar(view: PlanTabView): string {
  return wrap(
    <PlanCalendar
      view={view}
      anchor={TODAY}
      today={TODAY}
      timeZone="UTC"
      side="agency"
      data={{ bundles: [BUNDLE], posts: [], thumbs: { posts: {}, concepts: {} } }}
      onAnchor={() => {}}
      onWeekOf={() => {}}
      onOpen={() => {}}
      onAddTo={() => {}}
      onNewPlan={() => {}}
      reload={async () => {}}
    />,
  );
}

describe('plan titles: two lines, then an ellipsis', () => {
  it('the phone card title wraps to two lines', () => {
    const html = wrap(<PlanTabCard bundle={BUNDLE} covers={[]} onOpen={() => {}} />);
    const [title] = classesOf(html, PLAN_TITLE);
    expect(title).toContain('line-clamp-2');
    expect(title).toContain('[overflow-wrap:anywhere]');
    expect(title).not.toContain('truncate');
  });

  it('the week card title wraps to two lines', () => {
    const [title, ...rest] = classesOf(calendar('week'), ITEM_TITLE);
    expect(rest).toEqual([]);
    expect(title).toContain('line-clamp-2');
    expect(title).not.toContain('truncate');
  });

  it('the week card plan name wraps to two lines', () => {
    expect(classesOf(calendar('week'), PLAN_TITLE)).toContain(
      'line-clamp-2 [overflow-wrap:anywhere]',
    );
  });

  it('the empty-day menu row title wraps to two lines; the row stays a 44px target', () => {
    const html = wrap(
      <PlanDayMenu
        day={TODAY}
        anchor={{} as HTMLElement}
        plans={[BUNDLE]}
        tones={new Map([['p1', 'accent']])}
        onPick={() => {}}
        onNewPlan={() => {}}
        onClose={() => {}}
      />,
    );
    const [title] = classesOf(html, PLAN_TITLE);
    expect(title).toContain('line-clamp-2');
    expect(title).not.toContain('truncate');
    const row = html.match(/<button[^>]*data-plan-tab-menu-plan="p1"[^>]*>/)?.[0] ?? '';
    expect(row).toContain('min-h-[44px]');
  });
});

describe('plan titles: one line, then an ellipsis', () => {
  it('the chat plan card title stays on one line', () => {
    const html = renderToStaticMarkup(<PlanCardTop plan={PLAN} />);
    const [title] = classesOf(html, PLAN_TITLE);
    expect(title).toContain('truncate');
    expect(title).not.toContain('line-clamp-2');
  });

  it('a plan chip truncates', () => {
    const html = calendar('month');
    const chip = html.match(/data-plan-tab-chip="p1"[\s\S]*?<\/button>/)?.[0] ?? '';
    expect(classesOf(chip, PLAN_TITLE)).toEqual(['truncate']);
  });

  it('a month grid row truncates', () => {
    expect(classesOf(calendar('month'), ITEM_TITLE)).toEqual(['truncate']);
  });
});

describe('toolbar arrows', () => {
  it('week view: "Last week" and "Next week"', () => {
    const html = calendar('week');
    expect(html).toMatch(/aria-label="Last week"[^>]*data-plan-tab-prev=""/);
    expect(html).toMatch(/aria-label="Next week"[^>]*data-plan-tab-next=""/);
  });

  it('month view: "Last month" and "Next month"', () => {
    const html = calendar('month');
    expect(html).toMatch(/aria-label="Last month"[^>]*data-plan-tab-prev=""/);
    expect(html).toMatch(/aria-label="Next month"[^>]*data-plan-tab-next=""/);
    expect(html).not.toContain('Previous');
  });

  it('the arrows are 44px targets', () => {
    expect(calendar('week')).toMatch(/aria-label="Last week"[^>]*h-11 w-11/);
  });
});
