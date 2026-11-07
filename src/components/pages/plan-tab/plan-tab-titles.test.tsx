import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import type { PlanBundle, PlanItemRow, PlanRow } from '@/lib/chat/plans';

// How plan titles sit on the Plan tab: the plan card is ui/ListCard, whose
// title is one line with an ellipsis (every list card is the same height), as
// the chat plan card's title is. Line 1: the title and its time (words only:
// "Fri", "Today", "Mon", "Live", the end day "1 Nov"); line 2: the plan's
// dates and count, then its one tag.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/components/media/Thumbnail', () => ({ Thumbnail: () => null }));

import { PlanCardTop } from '@/components/chat/PlanCard';
import { PlanTabCard } from '@/components/pages/plan-tab/PlanTabList';

const NOW = new Date('2026-11-04T12:00:00Z');
const PLAN_TITLE = 'A very long festive season launch plan title';

const PLAN: PlanRow = {
  id: 'p1',
  workspace_id: 'ws',
  title: PLAN_TITLE,
  starts_on: '2026-11-06',
  ends_on: '2026-11-12',
  audience: 'client',
  created_by: null,
};

const ITEM: PlanItemRow = {
  id: 'i1',
  plan_id: 'p1',
  kind: 'concept',
  position: 0,
  title: 'A concept',
  description: null,
  post_id: null,
  created_at: '2026-10-01T00:00:00Z',
  target_date: '2026-11-06',
};

const BUNDLE: PlanBundle = {
  plan: PLAN,
  items: [ITEM],
  reviews: [],
  postStages: {},
  postInfo: {},
};

const wrap = (node: ReactElement): string =>
  renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The class lists of every element whose own text is exactly `text`. */
function classesOf(html: string, text: string): string[] {
  const re = new RegExp(`<\\w+[^>]*class="([^"]*)"[^>]*>${escape(text)}</`, 'g');
  return [...html.matchAll(re)].map((m) => m[1] ?? '');
}

function card(bundle: PlanBundle = BUNDLE, cover: string | null = null): string {
  return wrap(
    <PlanTabCard bundle={bundle} cover={cover} timeZone="UTC" now={NOW} onOpen={() => {}} />,
  );
}

describe('plan titles: one line, then an ellipsis', () => {
  it('the plan card title is ListCard line 1 (heading, one line)', () => {
    const html = card();
    expect(html).toContain('data-list-card=""');
    expect(html).toContain('data-plan-tab-card="p1"');
    const [title] = classesOf(html, PLAN_TITLE);
    expect(title).toContain('truncate');
  });

  it('the chat plan card title stays on one line', () => {
    const html = renderToStaticMarkup(<PlanCardTop plan={PLAN} />);
    const [title] = classesOf(html, PLAN_TITLE);
    expect(title).toContain('truncate');
  });
});

describe('the plan card lines', () => {
  it('line 1: the start day in words; line 2: the date range, the post count and "N of M OK"', () => {
    const html = card();
    expect(html).toMatch(
      /data-list-card-preview=""[^>]*data-plan-tab-dates=""[^>]*>6–12 Nov · 1 post</,
    );
    expect(html).toMatch(/data-list-card-time=""[^>]*data-plan-tab-start=""[^>]*>Fri</);
    expect(html).not.toMatch(/Starts|Started/);
    expect(html).toMatch(/data-list-card-tag=""[^>]*data-plan-tab-progress=""/);
    expect(html).toContain('0 of 1 OK');
    expect(html).not.toContain('data-plan-tab-draft');
  });

  it('a Draft that is on: "only your team sees this" and the Draft tag on line 2, "Live"', () => {
    const draft: PlanBundle = {
      ...BUNDLE,
      plan: { ...PLAN, audience: 'team', starts_on: '2026-11-01', ends_on: '2026-11-07' },
    };
    const html = card(draft);
    expect(html).toContain('1–7 Nov · 1 post · only your team sees this');
    expect(html).toMatch(/data-list-card-time=""[^>]*data-plan-tab-start=""[^>]*>Live</);
    expect(html).toMatch(/data-list-card-tag=""[^>]*data-plan-tab-draft=""/);
    expect(html).toContain('>Draft<');
  });

  it('the time: "Today" on its first day, the weekday within the week, the end day once over', () => {
    const at = (starts_on: string, ends_on: string): string =>
      card({ ...BUNDLE, plan: { ...PLAN, starts_on, ends_on } });
    const time = /data-list-card-time=""[^>]*data-plan-tab-start=""[^>]*>([^<]*)</;
    expect(at('2026-11-04', '2026-11-10').match(time)?.[1]).toBe('Today');
    expect(at('2026-11-09', '2026-11-15').match(time)?.[1]).toBe('Mon');
    expect(at('2026-10-26', '2026-11-01').match(time)?.[1]).toBe('1 Nov');
  });

  it('the picture: the plan icon box with no cover, the image slot with one', () => {
    expect(card()).toMatch(/data-list-card-picture="icon"[^>]*data-plan-tab-cover="icon"/);
    expect(card(BUNDLE, 'v1')).toMatch(
      /data-list-card-picture="image"[^>]*data-plan-tab-cover="image"/,
    );
  });

  it('the whole card is one button with no select (long-press does nothing)', () => {
    const html = card();
    expect(html.match(/data-list-card-press=""/g)).toHaveLength(1);
    expect(html).not.toContain('data-list-card-tick');
    expect(html).not.toContain('select-none');
  });
});
