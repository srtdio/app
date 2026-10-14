// Plan on a laptop (md and up): the docked panel's frame, the agency's grip,
// row buttons and keyboard wiring, the client's untouched rows, and the
// Sheet's additive fixed-height box. Gestures, drag and keys run end to end
// in e2e/tests/plan-desktop.spec.ts.

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
  planEscapeTaken,
  planListGroups,
  type PlanRowDesk,
} from '@/components/chat/PlanScreen';
import { placePopover } from '@/components/chat/PlanDayPopover';
import type { PlanBundle, PlanItemRow } from '@/lib/chat/plans';

const dir = fileURLToPath(new URL('..', import.meta.url));
const read = (name: string): string => readFileSync(`${dir}${name}`, 'utf8');
const ui = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../ui/${name}`, import.meta.url)), 'utf8');

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

function bundle(): PlanBundle {
  return {
    plan: {
      id: 'plan',
      workspace_id: 'ws',
      title: 'Week of 12 Oct',
      starts_on: '2026-10-12',
      ends_on: '2026-10-18',
      audience: 'client',
      created_by: 'creator',
    },
    items: [
      item({ id: 'c1', target_date: '2026-10-13', position: 0 }),
      item({ id: 'c2', target_date: '2026-10-20', position: 1 }),
    ],
    reviews: [],
    postStages: {},
    postInfo: {},
  } as unknown as PlanBundle;
}

const desk = (over: Partial<PlanRowDesk> = {}): PlanRowDesk => ({
  collapsing: new Set(),
  pickedId: null,
  popoverId: null,
  onCalendar: () => undefined,
  onMenu: () => undefined,
  onRemove: () => undefined,
  onKeyDown: () => undefined,
  onKeyUp: () => undefined,
  ...over,
});

const paint = (side: 'agency' | 'client', rowDesk?: PlanRowDesk): string =>
  renderToStaticMarkup(
    <MemoryRouter>
      <PlanBody
        bundle={bundle()}
        groups={planListGroups(bundle(), 'UTC', side)}
        side={side}
        timeZone="UTC"
        thumbs={{}}
        drag={null}
        onOpenItem={() => undefined}
        onToggleSlot={() => undefined}
        {...(side === 'agency' ? { onDragStart: () => undefined, onAdd: () => undefined } : {})}
        {...(rowDesk !== undefined ? { desk: rowDesk } : {})}
      />
    </MemoryRouter>,
  );

describe('laptop rows (agency)', () => {
  it('grip on droppable rows, calendar then dustbin left of the tick, no swipe', () => {
    const html = paint('agency', desk());
    // c1 is inside the plan (grip); c2 is dated outside it (a spacer keeps the column).
    expect(html.match(/data-plan-grip=""/g)).toHaveLength(1);
    expect(html.match(/data-plan-row-calendar=""/g)).toHaveLength(2);
    expect(html.match(/data-plan-row-bin=""/g)).toHaveLength(2);
    expect(html).not.toContain('data-plan-row-swipe');
    expect(html).not.toContain('data-plan-row-remove');
    const row = html.slice(html.indexOf('data-plan-row-wrap="c1"'));
    const order = [
      'data-plan-grip',
      'data-plan-row="c1"',
      'data-plan-row-calendar',
      'data-plan-row-bin',
      'data-plan-slot',
    ].map((k) => row.indexOf(k));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('grip 28x44 shown on hover or focus within; buttons 36x44, muted, hover panel-2', () => {
    const html = paint('agency', desk());
    expect(html).toMatch(
      /data-plan-grip=""[^>]*class="[^"]*h-11 w-7[^"]*cursor-grab[^"]*touch-none[^"]*opacity-0[^"]*group-focus-within:opacity-100[^"]*group-hover:opacity-100/,
    );
    expect(html).toMatch(
      /data-plan-row-calendar=""[^>]*class="[^"]*h-11 w-9[^"]*text-fg-3[^"]*hover:bg-panel-2/,
    );
    expect(html).toContain('select-none');
  });

  it('a picked-up row carries the accent outline and its marker', () => {
    const html = paint('agency', desk({ pickedId: 'c1' }));
    expect(html).toMatch(/data-plan-row="c1"[^>]*data-plan-row-picked=""[^>]*ring-accent/);
  });

  it('the list takes the keys (rows are the targets)', () => {
    const src = read('PlanScreen.tsx');
    expect(src).toContain('onKeyDown: desk.onKeyDown, onKeyUp: desk.onKeyUp');
  });
});

describe('laptop client view', () => {
  it('no grip, calendar, dustbin or menu; ticks as today', () => {
    const html = paint('client');
    for (const k of ['data-plan-grip', 'data-plan-row-calendar', 'data-plan-row-bin']) {
      expect(html).not.toContain(k);
    }
    expect(html).toContain('data-plan-slot="client"');
    const src = read('PlanScreen.tsx');
    expect(src).toContain('const deskAgency = desktop && agency;');
    expect(src).toMatch(/\{deskAgency \? <PlanKeyHints \/> : null\}/);
  });
});

describe('the docked panel', () => {
  it('440px, full height, border-left, bg-panel, translateX only, not modal', () => {
    const src = read('PlanScreen.tsx');
    expect(src).toContain('export const PLAN_PANEL_PX = 440;');
    expect(src).toContain(
      "'fixed inset-y-0 right-0 z-40 flex flex-col border-l border-border bg-panel",
    );
    expect(src).toContain("'translate-x-6 opacity-0 ease-exit'");
    expect(src).toContain("'translate-x-0 opacity-100 ease-enter'");
    expect(src).toContain("{ role: 'complementary' }");
    expect(src).toContain('min-[1180px]:shadow-none');
    // The phone page is unchanged.
    expect(src).toContain(
      "'fixed inset-0 z-40 flex flex-col bg-bg pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] transition-transform duration-slow ease-enter motion-reduce:transition-none'",
    );
  });

  it('the chat thread narrows by 440px from 1180px only while the panel is open', () => {
    const chat = read('ChatConnected.tsx');
    expect(chat).toContain("planPanelOpen && 'min-[1180px]:mr-[440px]'");
  });

  it('Escape is taken first by a field, drag, pick-up, menu or sheet', () => {
    const doc = (hit: boolean) =>
      ({ querySelector: () => (hit ? {} : null) }) as unknown as Document;
    expect(planEscapeTaken(doc(false), null)).toBe(false);
    expect(planEscapeTaken(doc(true), null)).toBe(true);
  });
});

describe('the day popover', () => {
  const vp = { width: 1280, height: 800 };
  it('under its button, right-aligned; flips above near the bottom; clamps inside', () => {
    const rect = { kind: 'rect' as const, left: 1100, right: 1136, top: 100, bottom: 144 };
    expect(placePopover(rect, { width: 240, height: 400 }, vp)).toEqual({ left: 896, top: 148 });
    const low = { ...rect, top: 700, bottom: 744 };
    expect(placePopover(low, { width: 240, height: 400 }, vp)).toEqual({ left: 896, top: 296 });
    const point = { kind: 'point' as const, x: 1270, y: 790 };
    expect(placePopover(point, { width: 240, height: 400 }, vp)).toEqual({ left: 1032, top: 392 });
  });
});

describe('Sheet: the fixed-height box is additive', () => {
  it('default keeps content height; fixedHeight sizes min(640px, 84vh) at sm+ only', () => {
    const src = ui('Sheet.tsx');
    expect(src).toContain('fixedHeight?: boolean;');
    expect(src).toContain("fixedHeight === true && 'sm:h-[min(640px,84vh)]'");
    expect(src).toContain('sm:max-h-[84vh]');
  });

  it('every plan sheet that loads or filters a list uses it', () => {
    expect(read('PlanAddSheet.tsx')).toContain('fixedHeight');
    expect(read('PlanPickerSheet.tsx')).toContain('title={PICKER_TITLE} fixedHeight');
    expect(read('PlanMoveSheet.tsx')).toContain('title="Move to" fixedHeight');
    expect(read('PlanDayPickerSheet.tsx')).toContain('title={props.title} fixedHeight');
  });
});
