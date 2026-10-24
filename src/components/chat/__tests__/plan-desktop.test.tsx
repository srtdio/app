// Plan on a laptop (md and up): the docked panel's frame, edit mode's grip,
// day chip, remove and keyboard wiring, view mode's plain rows, and the
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
  OTHER_ESCAPE_OWNERS,
  PLAN_PANEL_WIDTH,
  PlanBody,
  isTextField,
  planListGroups,
  type PlanRowEdit,
} from '@/components/chat/PlanScreen';
import { outOfView, placePopover } from '@/components/chat/PlanDayPopover';
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

const edit = (over: Partial<PlanRowEdit> = {}): PlanRowEdit => ({
  pickedId: null,
  dayOpenId: null,
  dragging: false,
  onDay: () => undefined,
  onRemove: () => undefined,
  onMenu: () => undefined,
  onKeyDown: () => undefined,
  onKeyUp: () => undefined,
  ...over,
});

const paint = (side: 'agency' | 'client', rowEdit?: PlanRowEdit): string =>
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
        onPlanOk={() => undefined}
        onPlanNotOk={() => undefined}
        {...(rowEdit !== undefined ? { onDragStart: () => undefined, edit: rowEdit } : {})}
        {...(side === 'agency' && rowEdit === undefined ? { onAdd: () => undefined } : {})}
      />
    </MemoryRouter>,
  );

describe('edit mode rows (agency, laptop and phone alike)', () => {
  it('grip, date tile, the row, then the bottom line (day chip, remove); PLAN as text, no swipe', () => {
    const html = paint('agency', edit());
    // c1 is inside the plan (grip); c2 is dated outside it (a spacer keeps the column).
    expect(html.match(/data-plan-grip=""/g)).toHaveLength(1);
    expect(html.match(/data-plan-row-day-chip=""/g)).toHaveLength(2);
    expect(html.match(/data-plan-row-remove-edit=""/g)).toHaveLength(2);
    expect(html).not.toContain('data-plan-row-swipe');
    expect(html).not.toContain('data-plan-row-remove="');
    // PLAN and POST stay as read-only text: no OK / Not OK switch, no pill.
    expect(html).toContain('data-plan-control="text"');
    expect(html).not.toContain('data-plan-control="switch"');
    expect(html).not.toContain('data-plan-control="pill"');
    expect(html).not.toContain('data-plan-ok=');
    expect(html.match(/data-plan-line="post"/g)).toHaveLength(2);
    expect(html.match(/data-plan-row-edit-line=""/g)).toHaveLength(2);
    expect(html).not.toContain('data-plan-add=');
    expect(html).toContain('data-plan-list-mode="edit"');
    const row = html.slice(html.indexOf('data-plan-row-wrap="c1"'));
    const order = [
      'data-plan-grip',
      'data-plan-day-col',
      'data-plan-row="c1"',
      'data-plan-line="plan"',
      'data-plan-row-edit-line',
      'data-plan-row-day-chip',
      'data-plan-row-remove-edit',
    ].map((k) => row.indexOf(k));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('grip 28x44, always shown, muted; the chip names the day; the remove is bad colour, 44px', () => {
    const html = paint('agency', edit());
    expect(html).toMatch(
      /data-plan-grip=""[^>]*class="[^"]*h-11 w-7[^"]*cursor-grab[^"]*touch-none/,
    );
    expect(html).not.toMatch(/data-plan-grip=""[^>]*opacity-0/);
    // The chip: the shared 44px secondary button (8px radius, bordered).
    expect(html).toMatch(
      /class="[^"]*h-11[^"]*rounded-lg[^"]*border[^"]*"[^>]*data-plan-row-day-chip=""/,
    );
    expect(html).not.toContain(
      'flex h-8 items-center gap-1.5 rounded-lg border border-border-strong',
    );
    expect(html).toContain('>Tue 13<');
    expect(html).toContain('>Tue 20<');
    expect(html).toMatch(
      /class="[^"]*h-11 w-11[^"]*text-bad[^"]*"[^>]*data-plan-row-remove-edit=""/,
    );
    expect(html).toContain('select-none');
  });

  it('a touch long-press never opens the day menu; nor does a running drag', () => {
    const src = read('PlanScreen.tsx');
    expect(src).toContain(
      "if (native.pointerType === 'touch' || lastPointer.current === 'touch') return;",
    );
    expect(src).toContain(
      'if (edit.onMenu === undefined || edit.dragging || wrapRef.current === null) return;',
    );
  });

  it('a picked-up row carries the accent outline and its marker', () => {
    const html = paint('agency', edit({ pickedId: 'c1' }));
    // PressableRow renders class before the spread data attributes.
    expect(html).toMatch(
      /class="[^"]*ring-2 ring-accent ring-offset-2[^"]*" data-plan-row="c1"[^>]*data-plan-row-picked=""/,
    );
  });

  it('the list takes the keys (rows are the targets) in edit mode only', () => {
    const src = read('PlanScreen.tsx');
    expect(src).toContain('{ onKeyDown: edit.onKeyDown, onKeyUp: edit.onKeyUp }');
    expect(src).toContain('if (!deskEditing || !(event.target instanceof HTMLElement)) return;');
  });
});

describe('view mode (laptop and phone)', () => {
  it('no grip, chip, remove or menu for anyone; the PLAN line as before', () => {
    for (const side of ['agency', 'client'] as const) {
      const html = paint(side);
      for (const k of ['data-plan-grip', 'data-plan-row-day-chip', 'data-plan-row-remove-edit']) {
        expect(html).not.toContain(k);
      }
      expect(html).toContain('data-plan-slot="client"');
    }
    const src = read('PlanScreen.tsx');
    expect(src).toContain('const deskAgency = desktop && agency;');
    expect(src).toContain('const deskEditing = deskAgency && editMode;');
    // The keyboard hint line sits in the edit header, never in the footer.
    expect(src).toContain('keyHints={deskEditing}');
    expect(src).not.toMatch(/\{deskAgency \? <PlanKeyHints \/> : null\}/);
  });
});

describe('the docked panel', () => {
  it('440px from 972px, 360px below (CSS, final on the first frame); full height, not modal', () => {
    expect(PLAN_PANEL_WIDTH).toBe('w-[360px] min-[972px]:w-[440px]');
    const src = read('PlanScreen.tsx');
    expect(src).not.toContain('PLAN_PANEL_PX');
    expect(src).toContain(
      "'fixed inset-y-0 right-0 z-40 flex flex-col border-l border-border bg-panel",
    );
    expect(src).toContain("'translate-x-6 opacity-0 ease-exit'");
    expect(src).toContain("'translate-x-0 opacity-100 ease-enter'");
    expect(src).toContain("{ role: 'complementary' }");
    // Left-edge shadow token while it overlays; none from 1180px.
    expect(src).toContain('[box-shadow:var(--shadow-panel-left)]');
    expect(src).toContain('min-[1180px]:[box-shadow:none]');
    const css = readFileSync(fileURLToPath(new URL('../../../index.css', import.meta.url)), 'utf8');
    expect(css.match(/--shadow-panel-left:/g)).toHaveLength(2);
    // One laptop query for every laptop layout.
    expect(src).toContain('useMediaQuery(LAPTOP_QUERY)');
    expect(src).not.toContain('usePlanDesktop');
    // The phone page is unchanged.
    expect(src).toContain(
      "'fixed inset-0 z-40 flex flex-col bg-bg pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] transition-transform duration-slow ease-enter motion-reduce:transition-none'",
    );
  });

  it('the chat thread narrows by 440px from 1180px; the list steps aside at 768 to 891px', () => {
    const chat = read('ChatConnected.tsx');
    expect(chat).toContain("planPanelOpen && 'min-[1180px]:mr-[440px]'");
    expect(chat).toContain('max-[891px]:invisible max-[891px]:absolute');
    expect(chat).toContain('useMediaQuery(LAPTOP_QUERY)');
  });

  it('Escape: inside the panel it stops at the panel; on the page only when nothing else owns it', () => {
    const src = read('PlanScreen.tsx');
    expect(src).toContain("el.addEventListener('keydown', inside);");
    expect(src).toMatch(/const inside = [\s\S]*?event\.stopPropagation\(\);/);
    expect(src).toContain("if (event.key !== 'Escape' || event.target !== document.body) return;");
    for (const owner of [
      '[role="dialog"]',
      '[role="menu"]',
      '[aria-expanded="true"]',
      '[data-selection-cancel]',
    ]) {
      expect(OTHER_ESCAPE_OWNERS).toContain(owner);
    }
    expect(isTextField({ tagName: 'INPUT' } as unknown as EventTarget)).toBe(true);
    expect(isTextField({ tagName: 'BUTTON' } as unknown as EventTarget)).toBe(false);
  });

  it('a drop commits once released: Escape cancels only while the pointer is down', () => {
    const src = read('PlanScreen.tsx');
    expect(src).toContain(
      "if (event.key === 'Escape' && stateRef.current?.snapTop === null) cancel();",
    );
  });
});

describe('the day popover', () => {
  const vp = { width: 1280, height: 800 };
  it('under its button, right-aligned; flips above near the bottom; never covers its button', () => {
    const rect = { kind: 'rect' as const, left: 1100, right: 1136, top: 100, bottom: 144 };
    expect(placePopover(rect, { width: 240, height: 400 }, vp)).toEqual({
      left: 896,
      top: 148,
      maxHeight: null,
    });
    const low = { ...rect, top: 700, bottom: 744 };
    expect(placePopover(low, { width: 240, height: 400 }, vp)).toEqual({
      left: 896,
      top: 296,
      maxHeight: null,
    });
    // Neither side fits: the roomier side, capped there.
    const mid = { ...rect, top: 340, bottom: 384 };
    expect(placePopover(mid, { width: 240, height: 500 }, vp)).toEqual({
      left: 896,
      top: 388,
      maxHeight: 404,
    });
    const point = { kind: 'point' as const, x: 1270, y: 790 };
    expect(placePopover(point, { width: 240, height: 400 }, vp)).toEqual({
      left: 1032,
      top: 392,
      maxHeight: null,
    });
  });

  it('closes once its row leaves the list view', () => {
    const view = { top: 60, bottom: 700 };
    expect(outOfView({ top: 100, bottom: 160 }, view)).toBe(false);
    expect(outOfView({ top: 10, bottom: 60 }, view)).toBe(true);
    expect(outOfView({ top: 700, bottom: 760 }, view)).toBe(true);
  });
});

describe('Sheet: the fixed-height box is additive', () => {
  it('default keeps content height; fixedHeight sizes min(640px, 84vh) at sm+ only', () => {
    const src = ui('Sheet.tsx');
    expect(src).toContain('fixedHeight?: boolean;');
    expect(src).toContain("fixedHeight === true && 'sm:h-[min(640px,84vh)]'");
    expect(src).toContain('sm:max-h-[84vh]');
  });

  it('every plan sheet that loads or filters a list uses it; the Day picker keeps content height', () => {
    expect(read('PlanAddSheet.tsx')).toContain('fixedHeight');
    expect(read('PlanPickerSheet.tsx')).toContain('title={PICKER_TITLE} fixedHeight');
    expect(read('PlanMoveSheet.tsx')).toContain('title="Move to" fixedHeight');
    expect(read('PostPicker.tsx')).toMatch(
      /title=\{PICKER_TITLES\[sheetMode\]\}[\s\S]*?fixedHeight/,
    );
    expect(read('PlanDayPickerSheet.tsx')).not.toContain('fixedHeight');
  });
});
