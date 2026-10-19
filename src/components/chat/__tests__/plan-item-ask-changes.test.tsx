// X3 / FT55 and FT52 on the item screen: "Ask changes" opens the comment
// composer first (Send records the note, then the review); approve keeps its
// confirm; a move that resets nothing waits behind the 7s Undo toast.

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
    expect(src).toMatch(/const askChanges = \(\): void => \{[\s\S]*?setAskingChanges\(true\);\s*commentRef\.current\?\.focus\(\);/);
    expect(src).toContain('ref={commentRef}');
    expect(src).toContain("data-plan-comment-send={askingChanges ? 'changes' : 'comment'}");
    expect(src).toMatch(/if \(steps\.includes\('changes'\)\) \{\s*if \(await review\('changes'\)\) setAskingChanges\(false\);/);
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

describe('FT52: plan undo toasts use useUndoableAction (7s, countdown)', () => {
  it('the item screen defers a move that resets nothing; the Plan screen defers a tick', () => {
    expect(UNDO_WINDOW_MS).toBe(7000);
    const item = read('PlanItemScreen.tsx');
    expect(item).toContain("import { useUndoableAction } from '@/lib/use-undoable-action';");
    expect(item).toMatch(/if \(spec\.undo\) \{[\s\S]*?undoable\.run\(\{\s*label: spec\.title,/);
    expect(item).not.toContain('SLOT_UNDO_MS');
    expect(item).not.toContain('moveBack');
    const screen = read('PlanScreen.tsx');
    expect(screen).toContain("import { useUndoableAction } from '@/lib/use-undoable-action';");
    expect(screen).toMatch(/undoable\.run\(\{\s*label: slotApprovedToast\(dayHeader\),/);
    expect(screen).not.toContain('SLOT_UNDO_MS');
    expect(screen).not.toContain("label: SLOT_UNDO");
    // useUndoableAction's toast carries the countdown.
    const hook = readFileSync(
      fileURLToPath(new URL('../../../lib/use-undoable-action.ts', import.meta.url)),
      'utf8',
    );
    expect(hook).toContain('countdown: true');
    expect(hook).toContain('durationMs: UNDO_WINDOW_MS');
  });
});
