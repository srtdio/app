// Plan list: swipe left to remove (agency only) and open at today. The pure
// rules and the rendered row; the gesture and timer cores are tested in
// src/lib/chat/use-row-swipe.test.ts.

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
  type PlanRowSwipe,
} from '@/components/chat/PlanScreen';
import { REMOVED_TOAST, REMOVE_FAILED, SWIPE_TIP_TOAST } from '@/components/chat/plan-card';
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

const swipe = (over: Partial<PlanRowSwipe> = {}): PlanRowSwipe => ({
  openId: null,
  collapsing: new Set(),
  peek: null,
  dragging: false,
  onStart: () => undefined,
  onSettle: () => undefined,
  onRemove: () => undefined,
  ...over,
});

const paint = (
  side: 'agency' | 'client',
  audience: 'team' | 'client',
  rowSwipe?: PlanRowSwipe,
): string =>
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
        onToggleSlot={() => undefined}
        {...(rowSwipe !== undefined ? { swipe: rowSwipe } : {})}
      />
    </MemoryRouter>,
  );

describe('swipe to remove: rendering', () => {
  it('agency rows on Draft and Open plans carry the swipe and the hidden Remove', () => {
    for (const audience of ['team', 'client'] as const) {
      const html = paint('agency', audience, swipe());
      expect(html).toContain('data-plan-row-swipe="c1"');
      expect(html).toMatch(/data-plan-row-remove="c1"[^>]*aria-hidden="true"[^>]*tabindex="-1"/);
      expect(html).toContain('touch-pan-y');
      expect(html).toContain('translateX(0px)');
    }
  });

  it('clients get nothing new, even if a swipe were handed down', () => {
    for (const audience of ['team', 'client'] as const) {
      const html = paint('client', audience, swipe());
      expect(html).not.toContain('data-plan-row-swipe');
      expect(html).not.toContain('data-plan-row-remove');
    }
    expect(paint('agency', 'team')).not.toContain('data-plan-row-remove');
  });

  it('the open row: translateX(-88px), the action 88px wide, full height, 44px min, danger tokens', () => {
    const html = paint('agency', 'team', swipe({ openId: 'c1' }));
    expect(html).toMatch(/data-plan-row-swipe="c1" data-plan-row-open=""/);
    expect(html).toContain('translateX(-88px)');
    const action = html.match(/<button[^>]*data-plan-row-remove="c1"[^>]*>/)?.[0] ?? '';
    expect(action).toContain('w-[88px]');
    expect(action).toContain('inset-y-0');
    expect(action).toContain('min-h-[44px]');
    expect(action).toContain('bg-bad');
    expect(action).toContain('select-none');
    expect(action).not.toContain('aria-hidden="true"');
    expect(action).not.toContain('pointer-events-none');
    expect(html).toContain('>Remove</button>');
    // Only that row is open.
    expect(html).toMatch(/data-plan-row-remove="c2"[^>]*aria-hidden="true"/);
  });

  it('the peek moves the content on translateX only; a collapsing row folds on height', () => {
    const peek = paint('agency', 'team', swipe({ peek: { id: 'c2', offset: -72 } }));
    expect(peek).toContain('translateX(-72px)');
    const collapsing = paint('agency', 'team', swipe({ collapsing: new Set(['c1']) }));
    expect(collapsing).toMatch(/data-plan-row-item="c1" data-plan-row-collapsing=""/);
    expect(collapsing).toContain('grid-rows-[0fr]');
    expect(collapsing).not.toMatch(/rotate|translateY|opacity-0/);
  });

  it('a hidden row leaves the list, the progress and its reviews', () => {
    const hidden = withoutItems(bundle(), new Set(['c1']));
    expect(hidden.items.map((i) => i.id)).toEqual(['c2']);
    expect(hidden.reviews).toEqual([]);
    expect(withoutItems(bundle(), new Set())).toEqual(bundle());
  });

  it('copy: no em-dashes; the existing remove toast and error are reused', () => {
    for (const copy of [SWIPE_TIP_TOAST, REMOVED_TOAST, REMOVE_FAILED]) {
      expect(copy).not.toContain('—');
    }
    expect(SWIPE_TIP_TOAST).toBe('Tip: swipe left on a slot to remove it');
    const src = read('PlanScreen.tsx');
    expect(src).toContain('planItemRemove(supabase, { p_item_id: id, p_trace_id: traceId })');
    expect(src).toContain('toastRef.current.show({ title: REMOVE_FAILED })');
    expect(src).toContain('title: REMOVED_TOAST');
    // The item screen's own Remove from plan is untouched.
    expect(read('PlanItemScreen.tsx')).toContain('toast.show({ title: REMOVE_FAILED })');
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
    expect(src).toContain('body.scrollTop +=');
    expect(src).not.toMatch(/scrollTo\(\{[^}]*smooth/);
  });
});
