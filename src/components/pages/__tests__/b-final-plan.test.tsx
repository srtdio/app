// Layout B-final, Plan area: the Plan screens (week, item, compose), the Plan
// tab and the Bank render the shared parts. The parts' new slots (HeaderBar
// titleSlot / titleProps / overlay, Card selected + data hooks, Toolbar data
// hooks) are additive; the trailing rule puts every trailing ⋯ / X glyph on
// the content edge; the bar keeps its height whatever the title holds.

import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { HeaderBar } from '@/components/ui/HeaderBar';
import { Card } from '@/components/ui/Card';
import { Toolbar } from '@/components/ui/Toolbar';
import { ActionMenuTrigger } from '@/components/ui/ActionMenu';
import { IconButton } from '@/components/ui/IconButton';
import { TRAILING_PULL } from '@/components/ui/layout';
import { IconPlus } from '@/components/ui/icons';

vi.mock('@/lib/use-is-laptop', async (orig) => ({
  ...(await orig<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => false,
}));

const html = (node: Parameters<typeof renderToStaticMarkup>[0]): string =>
  renderToStaticMarkup(node);
const read = (rel: string): string =>
  readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const barClass = (markup: string): string =>
  markup.match(/<header data-header-bar="" class="([^"]*)"/)?.[1] ?? '';

describe('HeaderBar slots (additive)', () => {
  it('titleSlot replaces the h1 in the same column; titleProps hook the column', () => {
    const out = html(
      <HeaderBar
        title="Week of 12 Oct"
        titleSlot={<span data-slot="">menu</span>}
        titleProps={{ 'data-plan-page-titles': '', tabIndex: -1 }}
      />,
    );
    expect(out).not.toContain('<h1');
    expect(out).toMatch(/data-plan-page-titles=""[^>]*tabindex="-1"[^>]*class="[^"]*flex-1/);
    expect(out).toContain('data-slot=""');
  });

  it('defaults unchanged: a plain h1 in the title role, no overlay stacking', () => {
    const out = html(<HeaderBar title="Plan" />);
    expect(out).toMatch(/<h1 class="text-lg font-semibold truncate">Plan<\/h1>/);
    expect(barClass(out)).not.toContain('relative');
  });

  it('overlay draws inside the bar, which stacks above the body', () => {
    const out = html(<HeaderBar title="Plan" overlay={<div data-menu="" />} />);
    expect(barClass(out)).toContain('relative');
    expect(barClass(out)).toContain('z-sticky');
    expect(out.indexOf('data-menu')).toBeGreaterThan(-1);
    expect(out.indexOf('data-menu')).toBeLessThan(out.indexOf('</header>'));
  });

  it('row height kept across states: h-14 with a subtitle, a title control or neither', () => {
    const states = [
      html(<HeaderBar compact title="Item" />),
      html(<HeaderBar compact title="Item" subtitle="Slot pending" />),
      html(<HeaderBar compact title="Item" titleSlot={<span>t</span>} subtitle="s" />),
    ];
    for (const out of states) {
      expect(barClass(out)).toContain('h-14');
      expect(barClass(out)).not.toContain('md:h-16');
      expect(barClass(out)).toContain('px-4 md:px-6');
    }
  });
});

describe('trailing rule on the Plan bar actions', () => {
  it('the ⋯ last pulls itself out by 12; an icon box last is pulled by the bar', () => {
    const more = html(<HeaderBar title="Item" actions={<ActionMenuTrigger type="button" />} />);
    expect(more).toMatch(new RegExp(`aria-label="More actions"[^>]*class="[^"]*${TRAILING_PULL}`));
    const close = html(
      <HeaderBar
        title="Plan"
        actions={
          <IconButton label="Add" data-plan-add="">
            <IconPlus />
          </IconButton>
        }
      />,
    );
    // The bar's rule: the last 44 icon box takes -mr-3 (its glyph on the edge).
    expect(close).toContain('[&amp;&gt;button.w-11:last-child]:-mr-3');
    expect(close).toContain('data-plan-add=""');
  });

  it('PlanPage renders the one HeaderBar: the ⋯ / X last, no hand-placed pull', () => {
    const src = read('chat/PlanScreen.tsx');
    const page = src.slice(
      src.indexOf('export function PlanPage'),
      src.indexOf('export type ScreenRead'),
    );
    expect(page).toContain('<HeaderBar');
    expect(page).not.toContain('<header');
    expect(page).not.toContain('-mr-3');
    expect(page).not.toContain('-ml-[11px]');
    const item = read('chat/PlanItemScreen.tsx');
    // The item's ⋯ carries no call-site classes: ActionMenuTrigger owns the pull.
    expect(item).not.toMatch(/data-plan-more=""[\s\S]{0,120}className="shrink-0 text-fg"/);
  });

  it('a Bank card has no ⋯: long-press selects and the old rows live on the select bar', () => {
    const bank = read('pages/plan-tab/BankList.tsx');
    expect(bank).not.toContain('ActionMenu');
    expect(bank).not.toMatch(/\bmenu[=:]/);
    expect(bank).not.toMatch(/\bcheck[=:]/);
    expect(bank).toContain('select={canWrite ? selection.selectFor(idea.id) : undefined}');
    expect(bank).toContain('<BankSelectBar');
    expect(bank).not.toContain('pr-4 pt-2');
    const bar = read('pages/plan-tab/BankSelectBar.tsx');
    expect(bar).toContain("from '@/components/ui/SelectBar'");
    expect(bar).toContain('visibleSelectActions');
  });
});

describe('Card slots (additive)', () => {
  it('selected swaps the card height for lit-selected; data hooks pass through', () => {
    const today = html(
      <Card selected data-plan-day="2026-10-13" data-plan-day-today="">
        x
      </Card>,
    );
    expect(today).toMatch(/^<div data-plan-day="2026-10-13" data-plan-day-today="" data-card=""/);
    expect(today).toContain('lit-selected');
    expect(today).not.toContain('lit-card');
    const other = html(<Card data-plan-day="2026-10-14">x</Card>);
    expect(other).toContain('lit-card');
    expect(other).not.toContain('lit-selected');
  });

  it('the Plan screens draw their day, status, description, buckets and who-can-see cards with Card', () => {
    const week = read('chat/PlanScreen.tsx');
    expect(week).toMatch(/<Card\s+key=\{day\.day \?\? 'none'\}/);
    expect(week).not.toContain("'mx-4 flex flex-col gap-4 rounded-xl border bg-panel p-3'");
    const item = read('chat/PlanItemScreen.tsx');
    for (const hook of [
      'data-plan-status=""',
      'data-plan-description-card=""',
      'data-plan-buckets=""',
      'data-plan-who-can-see=""',
    ]) {
      expect(item).toContain(`<Card ${hook}`);
    }
    expect(item).not.toContain('rounded-xl border bg-panel p-3 lit-card');
  });
});

describe('Toolbar data hooks (additive)', () => {
  it('data-* pass through; the bar stays 56 with the page edge', () => {
    const out = html(<Toolbar data-plan-tab-toolbar="" context={<span />} />);
    expect(out).toMatch(/^<div data-plan-tab-toolbar="" data-toolbar="" class="[^"]*h-14/);
    expect(out).toContain('px-4 md:px-6');
  });
});

describe('the Plan tab and the Bank on ListCard (phone and laptop)', () => {
  it('one ListCard per plan and per idea, in LIST_CARD_GRID; the calendar is retired', () => {
    const list = read('pages/plan-tab/PlanTabList.tsx');
    expect(list).toContain('<ListCard');
    expect(list).toContain('LIST_CARD_GRID');
    expect(list).toContain(
      'formatPlanStart(plan.starts_on, props.timeZone, props.now, plan.ends_on)',
    );
    // Plans have no select mode: long-press does nothing on a plan card.
    expect(list).not.toMatch(/\bselect=\{/);
    expect(list).toContain('<ListCardBox');
    const bank = read('pages/plan-tab/BankList.tsx');
    expect(bank).toContain('<ListCard');
    expect(bank).toContain('LIST_CARD_GRID');
    expect(bank).toContain('formatAdded');
    expect(bank).not.toContain('<SidePanel');
    expect(bank).not.toContain('<table');
    const tab = read('pages/PlanTabPage.tsx');
    expect(tab).not.toContain('PlanCalendar');
    expect(tab).not.toContain('useIsLaptop');
    // One clock for every card's time.
    expect(tab.match(/useMinuteClock\(\)/g)).toHaveLength(1);
  });
});

describe('words and icons', () => {
  it('the stage reads Review, never In review', async () => {
    const { stageStatusWord } = await import('@/lib/plan-tab');
    const { stageLabel } = await import('@/components/chat/plan-card');
    expect(stageStatusWord('review')).toBe('Review');
    expect(stageLabel('review')).toBe('Review');
  });

  it('Edit is the pencil and "Edit"; compose day rows drop the repeated calendar', () => {
    const item = read('chat/PlanItemScreen.tsx');
    expect(
      item.match(/<IconEdit size=\{ICON_SIZE\.inline\} \/>\s*Edit\s*<\/Button>/g),
    ).toHaveLength(2);
    const compose = read('chat/PlanComposeScreen.tsx');
    expect(compose).not.toContain('IconCalendar');
  });
});
