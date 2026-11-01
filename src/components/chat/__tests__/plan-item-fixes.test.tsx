// Plan item screen fixes: F1 the Edit concept sheet picks from the plan's day
// tiles (range, today, dayCounts as the Add concept caller passes them); F2 a
// failed concept save toasts planWriteErrorCopy; F4 Move and Remove land only
// on the item still open (no close, no toast after leaving, the plan still
// refreshes); F5 typing clears the comment's send error.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { CONCEPT_SAVE_FAILED, isLiveItem } from '@/components/chat/PlanItemScreen';
import { planWriteErrorCopy } from '@/components/chat/plan-card';

const dir = fileURLToPath(new URL('..', import.meta.url));
const read = (name: string): string => readFileSync(`${dir}${name}`, 'utf8');
const item = (): string => read('PlanItemScreen.tsx');
const between = (src: string, from: string, to: string): string =>
  src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));

describe('F1: Edit concept date is limited to the plan days', () => {
  it('the edit sheet gets range, today and dayCounts like Add concept', () => {
    const sheet = between(item(), '<ConceptSheet', '/>');
    expect(sheet).toContain('mode="edit"');
    expect(sheet).toContain(
      'range={{ startsOn: bundle.plan.starts_on, endsOn: bundle.plan.ends_on }}',
    );
    expect(sheet).toContain('today={civilToday(new Date(), timeZone)}');
    expect(sheet).toContain('dayCounts={dayCounts}');
    // The Add concept caller passes the same three props.
    const compose = between(read('PlanComposeScreen.tsx'), '<ConceptSheet', '/>');
    expect(compose).toContain('range={range}');
    expect(compose).toContain('today={today}');
    expect(compose).toContain('dayCounts={counts}');
  });

  it('dayCounts come from the bundle already held (planDayIds), no read', () => {
    const src = item();
    expect(src).toMatch(
      /for \(const d of planDayIds\(groups\)\) if \(d\.day !== null\) dayCounts\[d\.day\] = d\.ids\.length;/,
    );
    expect(src).toContain("import { civilToday } from '@/lib/plan-week';");
  });

  it('with a range the sheet shows the day tiles, not the native date field', () => {
    const sheet = read('ConceptSheet.tsx');
    expect(sheet).toMatch(/props\.range === undefined \? \(\s*<ConceptDateField/);
    expect(sheet).toMatch(/props\.range !== undefined \? \([\s\S]*?<PlanDayTiles/);
  });
});

describe('F2: a failed concept save toasts the shared write error copy', () => {
  it('saveEdit uses planWriteErrorCopy with CONCEPT_SAVE_FAILED as fallback', () => {
    const save = between(item(), 'const saveEdit', 'const shown');
    expect(save).toContain(
      'toast.show({ title: planWriteErrorCopy(result.error.message, CONCEPT_SAVE_FAILED) });',
    );
    expect(save).not.toContain('toast.show({ title: CONCEPT_SAVE_FAILED })');
    expect(planWriteErrorCopy('boom', CONCEPT_SAVE_FAILED)).toBe(CONCEPT_SAVE_FAILED);
    expect(planWriteErrorCopy('date_outside_plan', CONCEPT_SAVE_FAILED)).not.toBe(
      CONCEPT_SAVE_FAILED,
    );
  });
});

describe('F4: Move and Remove land only on the item still open', () => {
  it('isLiveItem: another item or a closed screen is not live', () => {
    expect(isLiveItem({ itemId: 'a', open: true }, 'a')).toBe(true);
    expect(isLiveItem({ itemId: 'b', open: true }, 'a')).toBe(false);
    expect(isLiveItem({ itemId: 'a', open: false }, 'a')).toBe(false);
  });

  it('writeMove: after leaving, no toast; a success still dispatches', () => {
    const move = between(item(), 'const writeMove', 'const moveItemTo');
    expect(move).toContain('const forItem = item.id;');
    expect(move).toContain('p_item_id: forItem,');
    expect(move).toMatch(
      /if \(!stillOn\(forItem\)\) \{\s*if \(result\.ok\) dispatchPlanChanged\(window, bundle\.plan\.id\);\s*return false;\s*\}/,
    );
    // The guard comes before the failure toast.
    expect(move.indexOf('stillOn(forItem)')).toBeLessThan(move.indexOf('toast.show('));
  });

  it('moveItemTo toasts only when writeMove landed on the open item', () => {
    const move = between(item(), 'const moveItemTo', 'const removeFromPlan');
    expect(move).toContain(
      'if (await writeMove(day, keep, order)) toast.show({ title: spec.title });',
    );
  });

  it('removeFromPlan: after leaving, no close and no toast; a success still dispatches', () => {
    const remove = between(item(), 'const removeFromPlan', 'const planRows');
    expect(remove).toContain('const forItem = item.id;');
    expect(remove).toContain('p_item_id: forItem,');
    expect(remove).toMatch(
      /if \(!stillOn\(forItem\)\) \{\s*if \(result\.ok\) dispatchPlanChanged\(window, bundle\.plan\.id\);\s*return;\s*\}/,
    );
    const guard = remove.indexOf('stillOn(forItem)');
    expect(guard).toBeLessThan(remove.indexOf('toast.show('));
    expect(guard).toBeLessThan(remove.indexOf('(props.onRemoved ?? props.onClose)()'));
  });
});

describe('F5: typing clears the comment send error', () => {
  it("the comment input's onChange sets the text and clears sendError", () => {
    expect(item()).toMatch(
      /ref=\{commentRef\}\s*compact\s*rows=\{1\}\s*value=\{text\}\s*onChange=\{\(e\) => \{\s*setText\(e\.target\.value\);\s*setSendError\(null\);\s*\}\}/,
    );
  });
});
