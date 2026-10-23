// X3 / FT55 and FT52 on the item screen: "Ask changes" opens the comment
// composer first (Send records the note, then the review); approve keeps its
// confirm; a move that resets nothing waits behind the 4s plan Undo toast. A
// row's Not OK opens the item screen with the note box open and focused.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import {
  ASK_CHANGES_HINT,
  ASK_CHANGES_PLACEHOLDER,
  askChangesSteps,
} from '@/components/chat/PlanItemScreen';
import { UNDO_WINDOW_MS } from '@/lib/use-undoable-action';

const dir = fileURLToPath(new URL('..', import.meta.url));
const read = (name: string): string => readFileSync(`${dir}${name}`, 'utf8');

describe('FT55: Ask changes opens the composer first', () => {
  it('what Send does: the note then the review; with no note the review alone; never nothing', () => {
    expect(askChangesSteps('Make it shorter', true)).toEqual(['comment', 'changes']);
    expect(askChangesSteps('   ', true)).toEqual(['changes']);
    expect(askChangesSteps('Nice', false)).toEqual(['comment']);
    expect(askChangesSteps('', false)).toEqual([]);
  });

  it('the button focuses the field and arms Send; approve still confirms', () => {
    const src = read('PlanItemScreen.tsx');
    expect(src).toContain('onClick={askChanges}');
    expect(src).not.toMatch(/onClick=\{\(\) => void review\('changes'\)\}/);
    expect(src).toMatch(
      /const askChanges = \(\): void => \{[\s\S]*?setAskingChanges\(true\);\s*commentRef\.current\?\.focus\(\);/,
    );
    expect(src).toContain('ref={commentRef}');
    expect(src).toContain("data-plan-comment-send={askingChanges ? 'changes' : 'comment'}");
    expect(src).toMatch(
      /if \(steps\.includes\('changes'\)\) \{\s*if \(await review\('changes'\)\) setAskingChanges\(false\);/,
    );
    // Approve keeps its confirm sheet.
    expect(src).toMatch(/data-plan-approve=""[\s\S]*?setConfirmOpen\(true\);/);
    expect(src).toContain("onConfirm={() => void review('approved')}");
    expect(ASK_CHANGES_HINT).toBe('Add a note on what should change, then send.');
    expect(ASK_CHANGES_PLACEHOLDER).toBe('What should change?');
    for (const s of [ASK_CHANGES_HINT, ASK_CHANGES_PLACEHOLDER]) {
      expect(s).not.toContain(String.fromCharCode(0x2014));
    }
  });
});

describe('Not OK on a row: the item screen asks changes at once', () => {
  it('askChanges opens the note box and focuses it; Send writes the PLAN side', () => {
    const src = read('PlanItemScreen.tsx');
    expect(src).toContain('askChanges?: boolean;');
    expect(src).toMatch(
      /if \(!props\.open \|\| props\.askChanges !== true\) return;[\s\S]*?setAskingChanges\(true\);/,
    );
    expect(src).toContain('if (askingChanges) commentRef.current?.focus();');
    // No review actions (a post item, say): the changes go to the viewer's PLAN side.
    expect(src).toMatch(
      /props\.askChanges === true\s*\?\s*slotSide\(side, bundle\.plan\.audience\)/,
    );
    expect(src).toContain('p_side: reviewSide,');
    // A post item shows the note form while asking.
    expect(src).toContain("item.kind === 'post' && !askingChanges ? undefined : (");
    const screen = read('PlanScreen.tsx');
    expect(screen).toMatch(
      /const planNotOk = [\s\S]*?undoable\.flush\(\);\s*setAskChanges\(true\);\s*setItemId\(item\.id\);/,
    );
    expect(screen).toContain('askChanges={askChanges}');
  });
});

describe('FT52: plan undo toasts use useUndoableAction (the 4s bottom strip)', () => {
  it('the item screen defers a move that resets nothing; the Plan screen defers an OK', () => {
    expect(UNDO_WINDOW_MS).toBe(4000);
    const item = read('PlanItemScreen.tsx');
    expect(item).toContain("import { useUndoableAction } from '@/lib/use-undoable-action';");
    expect(item).toContain('useUndoableAction()');
    expect(item).not.toContain('PLAN_UNDO_MS');
    expect(item).toMatch(/if \(spec\.undo\) \{[\s\S]*?undoable\.run\(\{\s*label: spec\.title,/);
    expect(item).not.toContain('SLOT_UNDO_MS');
    expect(item).not.toContain('moveBack');
    const screen = read('PlanScreen.tsx');
    expect(screen).toContain("import { useUndoableAction } from '@/lib/use-undoable-action';");
    expect(screen).toContain('useUndoableAction()');
    expect(screen).not.toContain('PLAN_UNDO_MS');
    expect(screen).toMatch(/undoable\.run\(\{\s*label: slotApprovedToast\(dayHeader\),/);
    expect(screen).not.toContain('SLOT_UNDO_MS');
    expect(screen).not.toContain('label: SLOT_UNDO');
    expect(read('plan-card.ts')).not.toContain('PLAN_UNDO_MS');
    // useUndoableAction's toast is the bottom strip over the one shared window;
    // no countdown and no per-caller window option.
    const hook = readFileSync(
      fileURLToPath(new URL('../../../lib/use-undoable-action.ts', import.meta.url)),
      'utf8',
    );
    expect(hook).toContain('export const UNDO_WINDOW_MS = 4000;');
    expect(hook).toContain("kind: 'undo',");
    expect(hook).toContain('durationMs: UNDO_WINDOW_MS,');
    expect(hook).not.toContain('countdown');
    expect(hook).not.toContain('options?.durationMs');
    expect(hook).toContain('export function useUndoableAction(): {');
  });
});
