// Plan on a laptop (md and up): the docked panel's frame, the creators' row
// ⋯ menu (no Edit mode, no grip or keyboard pick-up), and the Sheet's
// additive fixed-height box.

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
  type PlanRowMenu,
} from '@/components/chat/PlanScreen';
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

const rowMenu: PlanRowMenu = {
  openId: null,
  onOpenChange: () => undefined,
  onMove: () => undefined,
  onRemove: () => undefined,
};

const paint = (side: 'agency' | 'client'): string =>
  renderToStaticMarkup(
    <MemoryRouter>
      <PlanBody
        bundle={bundle()}
        groups={planListGroups(bundle(), 'UTC', side)}
        side={side}
        timeZone="UTC"
        thumbs={{}}
        onOpenItem={() => undefined}
        onPlanOk={() => undefined}
        onPlanNotOk={() => undefined}
        {...(side === 'agency' ? { onAdd: () => undefined, rowMenu } : {})}
      />
    </MemoryRouter>,
  );

describe('rows (laptop and phone alike)', () => {
  it('creators get one ⋯ menu per in-range row; approvers none; no grip, chip or remove', () => {
    const agency = paint('agency');
    // c1 sits inside the plan; c2's day is outside it, so it has no menu.
    expect(agency.match(/aria-label="More actions"/g)).toHaveLength(1);
    const client = paint('client');
    expect(client).not.toContain('aria-label="More actions"');
    for (const html of [agency, client]) {
      for (const k of ['data-plan-grip', 'data-plan-row-day-chip', 'data-plan-row-remove-edit']) {
        expect(html).not.toContain(k);
      }
      expect(html).toContain('data-plan-slot="client"');
    }
    const src = read('PlanScreen.tsx');
    expect(src).not.toContain('editMode');
    expect(src).not.toContain('PlanKeyHints');
    // Long-press and right-click open the same menu.
    expect(src).toContain('useMenuGesture(');
  });
});

describe('the docked panel', () => {
  it('440px from 972px, 360px below (CSS, final on the first frame); full height, not modal', () => {
    expect(PLAN_PANEL_WIDTH).toBe('w-plan-narrow min-[972px]:w-plan-panel');
    const src = read('PlanScreen.tsx');
    expect(src).not.toContain('PLAN_PANEL_PX');
    expect(src).toContain("'fixed inset-y-0 right-0 z-dock flex flex-col border-l bg-panel");
    // Laptop pane switches are instant (docs/motion.md): no slide, no fade.
    expect(src).not.toContain('translate-x-6 opacity-0');
    expect(src).toContain("{ role: 'complementary' }");
    // Lit as an overlay only while it sits over the chat (below 1180px); flat
    // beside the list from 1180px. No arbitrary box-shadow, and the old
    // --shadow-panel-left token is gone from index.css.
    expect(src).toContain("max-[1179px]:lit-overlay min-[1180px]:border-border',");
    expect(src).not.toContain('[box-shadow:');
    expect(src).not.toContain('--shadow-panel-left');
    const css = readFileSync(fileURLToPath(new URL('../../../index.css', import.meta.url)), 'utf8');
    expect(css).not.toContain('--shadow-panel-left');
    expect(css).toContain('.lit-overlay');
    // One laptop switch for every laptop layout.
    expect(src).toContain('useIsLaptop()');
    expect(src).not.toContain('usePlanDesktop');
    // The phone page pushes in from the right (pushIn), its edge a 1px ring.
    expect(src).toContain(
      "'fixed inset-0 z-dock flex flex-col bg-bg pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] ring-1 ring-border'",
    );
    expect(src).toContain('pushIn(el)');
  });

  it('the chat thread narrows by 440px from 1180px; the list steps aside at 768 to 891px', () => {
    const chat = read('ChatConnected.tsx');
    expect(chat).toContain("planPanelOpen && 'min-[1180px]:mr-plan-panel'");
    expect(chat).toContain('max-[891px]:invisible max-[891px]:absolute');
    expect(chat).toContain('useIsLaptop()');
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
});

describe('Sheet: the fixed-height box is additive', () => {
  it('default keeps content height; fixedHeight sizes min(640px, 84svh) at sm+ only', () => {
    const src = ui('Sheet.tsx');
    expect(src).toContain('fixedHeight?: boolean;');
    expect(src).toContain("fixedHeight === true && 'sm:h-[min(640px,84svh)]'");
    expect(src).toContain('sm:max-h-[84svh]');
  });

  it('every plan sheet that loads or filters a list uses it; the Day picker keeps content height', () => {
    expect(read('PlanAddSheet.tsx')).toContain('fixedHeight');
    expect(read('PlanPickerSheet.tsx')).toMatch(/title=\{PICKER_TITLE\}\s+fixedHeight/);
    expect(read('PlanMoveSheet.tsx')).toContain('title="Move to" fixedHeight');
    expect(read('PostPicker.tsx')).toMatch(
      /title=\{PICKER_TITLES\[sheetMode\]\}[\s\S]*?fixedHeight/,
    );
    expect(read('PlanDayPickerSheet.tsx')).not.toContain('fixedHeight');
  });
});
