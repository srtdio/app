// Plan list, view mode (X3): no swipe to remove, no row dustbin, no grip; the
// hidden-rows helper and open at today. (Swipe left to remove was retired with
// edit mode: removing is an edit, saved with Save changes.)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import {
  PlanBody,
  needsOpenScroll,
  planListGroups,
  todayScrollDay,
  withoutItems,
} from '@/components/chat/PlanScreen';
import type { PlanBundle, PlanItemRow } from '@/lib/chat/plans';

const dir = fileURLToPath(new URL('..', import.meta.url));
const read = (name: string): string => readFileSync(`${dir}${name}`, 'utf8');

function item(over: Partial<PlanItemRow> & { id: string }): PlanItemRow {
  return {
    plan_id: 'plan',
    kind: 'concept',
    position: 0,
    title: 'Reel',
    description: null,
    post_id: null,
    created_at: '2026-10-09T10:00:00Z',
    ...over,
  };
}

function bundle(audience: 'team' | 'client' = 'team'): PlanBundle {
  return {
    plan: {
      id: 'plan',
      workspace_id: 'ws',
      title: 'Week of 12 Oct',
      starts_on: '2026-10-12',
      ends_on: '2026-10-18',
      audience,
      created_by: 'creator',
    },
    items: [
      item({ id: 'c1', target_date: '2026-10-13', position: 0 }),
      item({ id: 'c2', target_date: '2026-10-15', position: 1 }),
    ],
    reviews: [{ item_id: 'c1', side: 'team', status: 'approved', reviewed_by: 'u' }],
    postStages: {},
    postInfo: {},
  };
}

const paint = (side: 'agency' | 'client', audience: 'team' | 'client'): string =>
  renderToStaticMarkup(
    <MemoryRouter>
      <PlanBody
        bundle={bundle(audience)}
        groups={planListGroups(bundle(audience), 'UTC', side)}
        side={side}
        timeZone="UTC"
        thumbs={{}}
        drag={null}
        onOpenItem={() => undefined}
        onPlanOk={() => undefined}
        onPlanNotOk={() => undefined}
        {...(side === 'agency' ? { onAdd: () => undefined } : {})}
      />
    </MemoryRouter>,
  );

describe('view mode rows: no swipe, no dustbin, no grip', () => {
  it('agency rows on Draft and Open plans carry only the row and the PLAN / POST lines', () => {
    for (const audience of ['team', 'client'] as const) {
      const html = paint('agency', audience);
      expect(html).not.toContain('data-plan-row-swipe');
      expect(html).not.toContain('data-plan-row-remove');
      expect(html).not.toContain('data-plan-grip');
      expect(html).not.toContain('data-plan-row-day-chip');
      expect(html).not.toContain('data-plan-row-remove-edit');
      expect(html).not.toContain('touch-pan-y');
      expect(html).not.toContain('translateX(');
      expect(html).toContain('data-plan-slot=');
      // Add rows stay in view mode (instant adds).
      expect(html).toContain('data-plan-add="2026-10-12"');
    }
  });

  it('clients get the same plain rows', () => {
    const html = paint('client', 'client');
    expect(html).not.toContain('data-plan-row-swipe');
    expect(html).not.toContain('data-plan-grip');
    expect(html).toContain('data-plan-slot="client"');
  });

  it('a hidden row leaves the list, the progress and its reviews', () => {
    const hidden = withoutItems(bundle(), new Set(['c1']));
    expect(hidden.items.map((i) => i.id)).toEqual(['c2']);
    expect(hidden.reviews).toEqual([]);
    expect(withoutItems(bundle(), new Set())).toEqual(bundle());
  });

  it('the screen no longer swipes, peeks or long-presses; removes are edit ops', () => {
    const src = read('PlanScreen.tsx');
    expect(src).not.toContain('use-row-swipe');
    expect(src).not.toContain('useLongPress');
    expect(src).not.toContain('runPlanPeek');
    expect(src).not.toContain('planItemRemove(');
    expect(src).toContain("queueOp(prev, { op: 'remove', item_id: id })");
  });
});

describe('long titles stay inside the column (view mode)', () => {
  const LONG_CONCEPT =
    'Lantern workshop with the whole extended family on the terrace at golden hour, shot handheld, then cut into a vertical reel with captions';
  const LONG_POST =
    'Opening offer carousel for the festive weekend: twelve frames, each with the price card, the store map and the booking link in the caption';
  const longBundle = (): PlanBundle => {
    const b = bundle();
    return {
      ...b,
      items: [
        item({ id: 'c1', target_date: '2026-10-13', position: 0, title: LONG_CONCEPT }),
        item({ id: 'p1', kind: 'post', title: null, post_id: 'post-1', position: 1 }),
      ],
      postInfo: { 'post-1': { title: LONG_POST, target_date: '2026-10-15T12:00:00Z' } },
    };
  };
  const tag = (html: string, attr: string): string =>
    html.match(new RegExp(`<[a-z]+[^>]*${attr}[^>]*>`))?.[0] ?? '';

  it('both long titles render in full text and clamp to two lines; every wrapper is min-w-0', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <PlanBody
          bundle={longBundle()}
          groups={planListGroups(longBundle(), 'UTC', 'agency')}
          side="agency"
          timeZone="UTC"
          thumbs={{}}
          drag={null}
          onOpenItem={() => undefined}
          onPlanOk={() => undefined}
        onPlanNotOk={() => undefined}
        />
      </MemoryRouter>,
    );
    for (const title of [LONG_CONCEPT, LONG_POST]) {
      expect(html).toMatch(
        new RegExp(
          `data-plan-row-title=""[^>]*class="[^"]*\\bline-clamp-2\\b[^"]*"[^>]*>${title.slice(0, 40)}`,
        ),
      );
    }
    for (const id of ['c1', 'p1']) {
      expect(tag(html, `data-plan-row-wrap="${id}"`)).toContain(
        'flex w-full min-w-0 items-start gap-3',
      );
      expect(tag(html, `data-plan-row="${id}"`)).toContain('min-w-0');
    }
  });
});

describe('open at today', () => {
  const plan = { starts_on: '2026-10-12', ends_on: '2026-10-25' };
  it('inside the range: today', () => {
    expect(todayScrollDay(plan, '2026-10-12', null)).toBe('2026-10-12');
    expect(todayScrollDay(plan, '2026-10-19', null)).toBe('2026-10-19');
    expect(todayScrollDay(plan, '2026-10-25', null)).toBe('2026-10-25');
  });
  it('before or after the range: the top', () => {
    expect(todayScrollDay(plan, '2026-10-11', null)).toBeNull();
    expect(todayScrollDay(plan, '2026-10-26', null)).toBeNull();
  });
  it('a deep-linked item keeps priority', () => {
    expect(todayScrollDay(plan, '2026-10-19', 'item-1')).toBeNull();
  });
  it('once per open: a re-read of the same plan never re-scrolls', () => {
    expect(needsOpenScroll(null, 'plan')).toBe(true);
    expect(needsOpenScroll('plan', 'plan')).toBe(false);
    expect(needsOpenScroll('plan', 'other')).toBe(true);
  });
  it('set before paint, never animated', () => {
    const src = read('PlanScreen.tsx');
    expect(src).toMatch(
      /useLayoutEffect\(\(\) => \{\s*if \(!props\.open\) \{\s*scrolledFor\.current = null;/,
    );
    expect(src).toContain('body.scrollTop = Math.round(');
    expect(src).not.toMatch(/scrollTo\(\{[^}]*smooth/);
  });
});
