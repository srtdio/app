import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

// The screens' import graph pulls the real agora-chat browser SDK; mock it so
// importing in node never touches browser globals (mirrors PlanCard.test.tsx).
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { renderToStaticMarkup } from 'react-dom/server';
import { SlotCheckbox, screenProgressLabel } from '@/components/chat/PlanScreen';
import {
  SLOT_FAILED,
  SLOT_POST_NOT_READY,
  SLOT_REMOVED_TOAST,
  itemPills,
  itemSlotSubtitle,
  planProgress,
  progressPercent,
  slotApprovedToast,
  slotCheckboxShown,
  slotSide,
  slotTicked,
  slotToastSpec,
  withReviewOverrides,
} from '@/components/chat/plan-card';
import type { PlanBundle, PlanItemRow } from '@/lib/chat/plans';

const dir = fileURLToPath(new URL('..', import.meta.url));
const read = (name: string): string => readFileSync(`${dir}${name}`, 'utf8');

function item(over: Partial<PlanItemRow>): PlanItemRow {
  return {
    id: 'i',
    plan_id: 'plan',
    kind: 'post',
    position: 0,
    title: null,
    description: null,
    post_id: null,
    created_at: '2026-10-09T10:00:00Z',
    ...over,
  };
}

function bundle(audience: 'team' | 'client'): PlanBundle {
  return {
    plan: {
      id: 'plan',
      workspace_id: 'ws',
      title: 'Week',
      starts_on: '2026-10-12',
      ends_on: '2026-10-18',
      audience,
      created_by: null,
    },
    items: [
      item({ id: 'p1', post_id: 'post1' }),
      item({ id: 'p2', post_id: 'post2' }),
      item({ id: 'd1', post_id: 'draft1' }),
      item({ id: 'c1', kind: 'concept', title: 'Reel' }),
    ],
    reviews: [
      { item_id: 'p1', side: 'client', status: 'approved' },
      { item_id: 'p2', side: 'team', status: 'approved' },
      { item_id: 'c1', side: 'client', status: 'changes' },
    ],
    postStages: { post1: 'review', post2: 'approved', draft1: 'draft' },
    postInfo: {
      post1: { title: 'One', target_date: '2026-10-13T06:00:00Z' },
      post2: { title: 'Two', target_date: null },
      draft1: { title: 'Draft', target_date: null },
    },
  };
}

const at = (b: PlanBundle, id: string): PlanItemRow => b.items.find((i) => i.id === id)!;

describe('checkbox per role (W4)', () => {
  it('client on a client plan writes the client side; agency the team side; else none', () => {
    expect(slotSide('client', 'client')).toBe('client');
    expect(slotSide('client', 'team')).toBeNull();
    expect(slotSide('agency', 'client')).toBe('team');
    expect(slotSide('agency', 'team')).toBe('team');
    expect(slotSide('unknown', 'client')).toBeNull();
  });

  it('a draft locked to a client has no checkbox; the agency keeps one on it', () => {
    const b = bundle('client');
    expect(slotCheckboxShown(b, at(b, 'd1'), 'client')).toBeNull();
    expect(slotCheckboxShown(b, at(b, 'd1'), 'agency')).toBe('team');
    expect(slotCheckboxShown(b, at(b, 'p1'), 'client')).toBe('client');
  });

  it('ticked reads the side the viewer writes: a client never sees team state', () => {
    const b = bundle('client');
    // p2 is team approved: the client's box stays empty, the agency's is ticked.
    expect(slotTicked(b, 'p2', 'client')).toBe(false);
    expect(slotTicked(b, 'p2', 'team')).toBe(true);
    // A post at stage approved with no client review is not a ticked slot.
    expect(slotTicked(b, 'p2', 'client')).toBe(false);
    // Concept 'changes' shows unticked.
    expect(slotTicked(b, 'c1', 'client')).toBe(false);
    expect(itemPills(b, at(b, 'p2'), 'client').map((p) => p.side)).toEqual(['client']);
  });

  it('the checkbox is a 22px box in a 44x44 target, with tokens only', () => {
    const html = renderToStaticMarkup(
      <SlotCheckbox side="client" checked title="One" onToggle={() => undefined} />,
    );
    expect(html).toContain('role="checkbox"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('h-11 w-11');
    expect(html).toContain('h-[22px] w-[22px]');
    expect(html).toContain('data-plan-slot="client"');
    expect(html).not.toMatch(new RegExp(`${String.fromCharCode(35)}[0-9a-f]{3,6}`, 'i'));
    const off = renderToStaticMarkup(
      <SlotCheckbox side="team" checked={false} title="One" onToggle={() => undefined} />,
    );
    expect(off).toContain('aria-checked="false"');
    expect(off).toContain('data-plan-slot-state="pending"');
  });
});

describe('optimistic counts and toasts (W4, W6)', () => {
  it('an override moves the pills, the counts and the bar together', () => {
    const b = bundle('client');
    expect(planProgress(b)).toMatchObject({ approved: 1, total: 4, changes: 1 });
    const ticked = withReviewOverrides(b, 'client', { p2: 'approved', c1: 'approved' });
    expect(planProgress(ticked)).toMatchObject({ approved: 3, changes: 0 });
    expect(progressPercent(planProgress(ticked))).toBe(75);
    expect(screenProgressLabel(ticked, 'client')).toBe('3/4 approved');
    // Reverting is laying the previous status back.
    const reverted = withReviewOverrides(ticked, 'client', { p2: 'waiting', c1: 'changes' });
    expect(planProgress(reverted)).toMatchObject({ approved: 1, changes: 1 });
    // No override: the very same bundle.
    expect(withReviewOverrides(b, 'client', {})).toBe(b);
    // Team overrides never touch the client count.
    expect(planProgress(withReviewOverrides(b, 'team', { p1: 'approved' }))).toMatchObject({
      approved: 1,
      teamApproved: 2,
    });
  });

  it('tick: "Slot approved · Tue 14 Oct" with Undo; untick: removed, no Undo; undo: silent', () => {
    expect(slotApprovedToast('Tue 14 Oct')).toBe('Slot approved · Tue 14 Oct');
    expect(slotToastSpec('tick', { ok: true }, 'Tue 14 Oct')).toEqual({
      title: 'Slot approved · Tue 14 Oct',
      undo: true,
    });
    expect(slotToastSpec('tick', { ok: true }, null)).toEqual({
      title: 'Slot approved',
      undo: true,
    });
    expect(slotToastSpec('untick', { ok: true }, 'Tue 14 Oct')).toEqual({
      title: SLOT_REMOVED_TOAST,
      undo: false,
    });
    expect(slotToastSpec('undo', { ok: true }, 'Tue 14 Oct')).toBeNull();
  });

  it('failure copy: the draft refusal, else the generic one', () => {
    expect(slotToastSpec('tick', { ok: false, message: 'post_not_ready' }, null)).toEqual({
      title: SLOT_POST_NOT_READY,
      undo: false,
    });
    expect(SLOT_POST_NOT_READY).toBe("This post isn't ready yet.");
    expect(slotToastSpec('undo', { ok: false, message: 'forbidden_role' }, null)?.title).toBe(
      SLOT_FAILED,
    );
    expect(SLOT_FAILED).toBe("Couldn't update this slot. Try again.");
  });

  it('the screen wires the write through runSlotWrite, dispatches on success, Undo writes waiting', () => {
    const src = read('PlanScreen.tsx');
    expect(src).toContain('await runSlotWrite({');
    expect(src).toContain('p_trace_id: traceId');
    expect(src).toContain('dispatchPlanChanged(window, planId);');
    expect(src).toMatch(
      /void writeSlot\(item, reviewSide, 'waiting', 'approved', 'undo', dayHeader\)/,
    );
    // A slot write never touches posts.stage (no stage transition on this screen).
    expect(src).not.toContain('stageTransition');
    expect(src).not.toContain('data-plan-tab');
  });
});

describe('post item header (W7, W8)', () => {
  it('subtitle matrix: client reads client; agency client on a client plan, team on a team plan', () => {
    const c = bundle('client');
    expect(itemSlotSubtitle(c, at(c, 'p1'), 'client')).toBe('Slot approved');
    expect(itemSlotSubtitle(c, at(c, 'p2'), 'client')).toBe('Slot pending');
    expect(itemSlotSubtitle(c, at(c, 'p1'), 'agency')).toBe('Slot approved');
    expect(itemSlotSubtitle(c, at(c, 'p2'), 'agency')).toBe('Slot pending');
    const t = bundle('team');
    expect(itemSlotSubtitle(t, at(t, 'p2'), 'agency')).toBe('Slot approved');
    expect(itemSlotSubtitle(t, at(t, 'p1'), 'agency')).toBe('Slot pending');
    expect(itemSlotSubtitle(c, at(c, 'c1'), 'client')).toBeNull();
    expect(itemSlotSubtitle(c, at(c, 'p1'), 'unknown')).toBeNull();
  });

  it('PlanPage renders the action after a flex-1 min-w-0 title column with truncation', () => {
    const src = read('PlanScreen.tsx');
    const header = src.slice(src.indexOf('<header'), src.indexOf('</header>'));
    expect(header).toMatch(/className="flex min-w-0 flex-1 flex-col"/);
    expect(header).toContain('<h2 className="truncate');
    expect(header.indexOf('{props.action}')).toBeGreaterThan(header.indexOf('</h2>'));
    const item = read('PlanItemScreen.tsx');
    expect(item).toContain('action: (');
    expect(item).toContain('data-plan-more=""');
    expect(item).not.toContain('absolute right-3');
  });
});
