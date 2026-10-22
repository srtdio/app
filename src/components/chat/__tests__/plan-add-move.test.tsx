import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

// The screens' import graph pulls the real agora-chat browser SDK; mock it so
// importing in node never touches browser globals (mirrors PlanCard.test.tsx).
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import {
  ADD_FAILED,
  DATE_OUTSIDE_PLAN,
  MOVE_FAILED,
  addSheetTitle,
  addedToast,
  itemStatusLine,
  movedToast,
  planHeaderSubtitle,
  planProgressView,
  planRangeShort,
  planWriteErrorCopy,
} from '@/components/chat/plan-card';
import {
  dropDayLabel,
  planDayIds,
  planListGroups,
  planMoveDays,
} from '@/components/chat/PlanScreen';
import type { PlanBundle, PlanItemRow } from '@/lib/chat/plans';

const dir = fileURLToPath(new URL('..', import.meta.url));
const read = (name: string): string => readFileSync(`${dir}${name}`, 'utf8');

function item(id: string, over: Partial<PlanItemRow> = {}): PlanItemRow {
  return {
    id,
    plan_id: 'plan',
    kind: 'concept',
    position: 0,
    title: id,
    description: null,
    post_id: null,
    created_at: '2026-10-09T10:00:00Z',
    target_date: null,
    ...over,
  };
}

const BUNDLE: PlanBundle = {
  plan: {
    id: 'plan',
    workspace_id: 'ws',
    title: 'Week',
    starts_on: '2026-10-12',
    ends_on: '2026-10-16',
    audience: 'team',
    created_by: null,
  },
  items: [
    item('c1', { target_date: '2026-10-14' }),
    // A stale plan_items.target_date (2 Oct) never places a post slot; its
    // post's target_date (15 Oct) does.
    item('p1', {
      kind: 'post',
      title: null,
      post_id: 'post1',
      target_date: '2026-10-02',
      position: 1,
    }),
    item('u1', { position: 2 }),
  ],
  reviews: [{ item_id: 'c1', side: 'client', status: 'changes' }],
  postStages: { post1: 'review' },
  postInfo: {
    post1: { title: 'Carousel', target_date: '2026-10-15T12:00:00Z', format: 'carousel' },
  },
};

describe('header, progress and status (A1)', () => {
  it('subtitle: "{range} · Draft" or "{range} · Shared with approvers" (item 3)', () => {
    expect(planRangeShort('2026-10-12', '2026-10-16')).toBe('12 to 16 Oct');
    expect(planRangeShort('2026-10-28', '2026-11-03')).toBe('28 Oct to 3 Nov');
    expect(planHeaderSubtitle(BUNDLE.plan)).toBe('12 to 16 Oct · Draft');
    expect(planHeaderSubtitle({ ...BUNDLE.plan, audience: 'client' })).toBe(
      '12 to 16 Oct · Shared with approvers',
    );
  });

  it('progress: Draft "Creators X of N" (accent bar), Open "Approved X of N" (good bar) (item 5)', () => {
    expect(planProgressView(BUNDLE)).toEqual({
      lead: 'Creators 0 of 3',
      percent: 0,
      tone: 'accent',
    });
    const open = { ...BUNDLE, plan: { ...BUNDLE.plan, audience: 'client' as const } };
    expect(planProgressView(open)).toEqual({ lead: 'Approved 0 of 3', percent: 0, tone: 'good' });
    const src = read('PlanScreen.tsx');
    const block = src.slice(src.indexOf('export function PlanProgressRow'));
    // Two boxes (PLAN, POST); their counts are in JetBrains Mono.
    expect(block.slice(0, 2500)).toContain('data-plan-screen-progress={box.key}');
    expect(block.slice(0, 2500)).toContain('font-mono');
  });

  it('status line: agency only, "Client waiting / approved / changes asked"', () => {
    const at = (id: string): PlanItemRow => BUNDLE.items.find((i) => i.id === id)!;
    expect(itemStatusLine(BUNDLE, at('c1'), 'agency')).toEqual({
      label: 'Changes asked',
      tone: 'review',
    });
    expect(itemStatusLine(BUNDLE, at('p1'), 'agency')?.label).toBe('Waiting for approval');
    expect(itemStatusLine(BUNDLE, at('p1'), 'client')).toBeNull();
  });
});

describe('grouping by plan day (A5)', () => {
  it("a post sits on its post's target_date in the zone, never plan_items.target_date (item 8)", () => {
    const groups = planListGroups(BUNDLE, 'UTC', 'agency');
    const days = planDayIds(groups);
    expect(days.map((d) => d.day)).toEqual([
      '2026-10-12',
      '2026-10-13',
      '2026-10-14',
      '2026-10-15',
      '2026-10-16',
      null,
    ]);
    expect(days.find((d) => d.day === '2026-10-15')?.ids).toEqual(['p1']);
    expect(days.find((d) => d.day === null)?.ids).toEqual(['u1']);
    // No 2 Oct group: a post slot's plan_items.target_date is never read.
    expect(days.some((d) => d.day === '2026-10-02')).toBe(false);
    // A client gets No date only when something is undated.
    const clientDays = planDayIds(
      planListGroups({ ...BUNDLE, items: BUNDLE.items.slice(0, 2) }, 'UTC', 'client'),
    );
    expect(clientDays.some((d) => d.day === null)).toBe(false);
  });

  it('Move offers the plan days and No date; drop slots name the day', () => {
    expect(planMoveDays(BUNDLE.plan).map((d) => d.label)).toEqual([
      'Mon 12 Oct',
      'Tue 13 Oct',
      'Wed 14 Oct',
      'Thu 15 Oct',
      'Fri 16 Oct',
      'No date',
    ]);
    expect(dropDayLabel('2026-10-14')).toBe('Wed 14');
    expect(dropDayLabel(null)).toBe('No date');
  });
});

describe('add (A2) and move (A3, A4) copy and calls', () => {
  it('Add sheet titles and toasts', () => {
    expect(addSheetTitle('Wed 14 Oct')).toBe('Add to Wed 14 Oct');
    expect(addSheetTitle(null)).toBe('Add to plan');
    expect(addedToast('post', 'Wed 14 Oct')).toBe('Added to Wed 14 Oct');
    expect(addedToast('concept', 'Wed 14 Oct')).toBe('Concept added to Wed 14 Oct');
  });

  it('move toasts: "ticks were reset" only when it had a tick; failures', () => {
    expect(movedToast('Thu 15 Oct', true)).toBe('Moved to Thu 15 Oct. Its ticks were reset.');
    expect(movedToast('Thu 15 Oct', false)).toBe('Moved to Thu 15 Oct.');
    expect(movedToast(null, false)).toBe('Moved to No date.');
    expect(planWriteErrorCopy('date_outside_plan', MOVE_FAILED)).toBe(DATE_OUTSIDE_PLAN);
    expect(DATE_OUTSIDE_PLAN).toBe('That day is outside this plan.');
    expect(planWriteErrorCopy('boom', MOVE_FAILED)).toBe("Couldn't move this item. Try again.");
    expect(planWriteErrorCopy('boom', ADD_FAILED)).toBe("Couldn't add. Try again.");
  });

  it('the screen adds a concept with the day, posts with p_target_date, "+" with no day', () => {
    const src = read('PlanScreen.tsx');
    expect(src).toContain("setConceptForm({ ...EMPTY_CONCEPT, date: addFor.day ?? '' });");
    expect(src).toContain('targetDate: date,');
    expect(src).toContain('...(day !== null ? { p_target_date: day } : {}),');
    expect(src).toContain('onClick={() => openAdd(null)}');
    expect(src).toContain('excludePostIds={inPlan}');
    // A drop queues one 'move' op with the full order; plan_save writes it.
    expect(src).toContain('item_ids: order,');
    expect(src).not.toContain('planItemMove(');
    expect(src.match(/planSave\(supabase/g)).toHaveLength(1);
    // Every write carries a trace id.
    for (const call of ['planSave(', 'planPostsAdd(', 'planConceptAdd(']) {
      expect(src).toContain(call);
    }
    expect(src.match(/p_trace_id: traceId/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('agency only: Add rows and "+" in view mode; grip, chip and remove in edit mode', () => {
    const src = read('PlanScreen.tsx');
    expect(src).toMatch(/:\s*agency\s*\?\s*\{\s*onAdd: openAdd\s*\}/);
    expect(src).toMatch(/\{\.\.\.\(editing\s*\?\s*\{\s*onDragStart:/);
    expect(src).toContain('const deskAgency = desktop && agency;');
    expect(src).toContain("const agency = side === 'agency' && bundle !== null;");
    expect(src).toContain('const editing = agency && editMode;');
    expect(src).toMatch(/\{agency \? \(\s*<>\s*<PlanConfirmSheet[\s\S]*<PlanAddSheet/);
    const item = read('PlanItemScreen.tsx');
    expect(item).toContain("const planActions = side === 'agency';");
    expect(item).toContain('{planActions ? (');
    expect(item).toContain("{...(item.kind === 'concept' && planActions");
    // A client gets no plan rows in the post view's sheet.
    expect(item).toContain('<PostSheetPlanRowsContext.Provider value={planRows}>');
    expect(item).toMatch(/planActions \? \{ onMove: \(\) => setMoveOpen\(true\) \}/);
    // Remove from plan is the screen's red button, not a menu row (item 10).
    expect(item).toContain('<RemoveFromPlanButton');
    expect(item).not.toMatch(/onRemove: \(\) => setRemoveOpen/);
  });

  it('drag cleans up every listener, frame and timer; Escape and pointercancel cancel with no change', () => {
    const src = read('PlanScreen.tsx');
    const hook = src.slice(src.indexOf('function usePlanDrag('), src.indexOf('function DragCard('));
    for (const ev of ['pointermove', 'pointerup', 'pointercancel', 'keydown', 'touchmove']) {
      expect(hook).toContain(`window.addEventListener('${ev}'`);
      expect(hook).toContain(`window.removeEventListener('${ev}'`);
    }
    expect(hook).toContain('cancelAnimationFrame(frame)');
    expect(hook).toContain('clearTimeout(snapTimer)');
    // Escape cancels while the pointer is down; once released the drop commits.
    expect(hook).toContain(
      "if (event.key === 'Escape' && stateRef.current?.snapTop === null) cancel();",
    );
    expect(hook).toContain('useEffect(() => end, [end]);');
    // A cancel never calls onDrop.
    const cancel = hook.slice(hook.indexOf('const cancel = (): void => end();'));
    expect(cancel.startsWith('const cancel = (): void => end();')).toBe(true);
  });
});
