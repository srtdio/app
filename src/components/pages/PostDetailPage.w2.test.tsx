import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';

// The page's import graph pulls the real agora-chat browser SDK. Mock it so
// importing the hookless pieces in node never touches browser globals.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import {
  StageReasonConfirm,
  captionDraftKey,
  captionSaveLabel,
  captionSaveNote,
  pinDraftKey,
} from '@/components/pages/PostDetailPage';
import {
  COMMENT_DISCARD,
  COMMENT_POST_FAILED,
} from '@/components/pages/pcs/CaptionAnnotationComposer';
import { stageReasonConfirm } from '@/components/pages/pcs/stage-actions';

// W2 regressions. node environment, no DOM: hookless trees are walked, and the
// wiring that lives inside hooks is pinned against the source.

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const PAGE = read('./PostDetailPage.tsx');

function collect(node: ReactNode, out: ReactElement[]): void {
  if (Array.isArray(node)) {
    node.forEach((child) => collect(child, out));
    return;
  }
  if (node === null || typeof node !== 'object' || !('props' in node)) return;
  const el = node as ReactElement;
  out.push(el);
  const p = el.props as { children?: ReactNode; footer?: ReactNode };
  collect(p.children, out);
  collect(p.footer, out);
}

function walk(tree: ReactNode): ReactElement[] {
  const out: ReactElement[] = [];
  collect(tree, out);
  return out;
}

describe('1. reject / park: confirm with reason, optimistic stage, deferred commit', () => {
  it('the confirm shows the title, the optional reason field, Cancel and a destructive Reject', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const tree = StageReasonConfirm({
      copy: stageReasonConfirm('rejected'),
      reason: '',
      onReasonChange: () => {},
      onCancel,
      onConfirm,
    });
    const sheet = tree as ReactElement<{ open: boolean; title: string }>;
    expect(sheet.props.open).toBe(true);
    expect(sheet.props.title).toBe('Reject this post?');
    const els = walk(tree);
    const field = els.find(
      (el) =>
        (el.props as { 'aria-label'?: string })['aria-label'] ===
        'Reason (optional), goes to the comments',
    );
    expect(field).toBeDefined();
    const confirm = els.find(
      (el) => (el.props as { 'data-stage-confirm'?: string })['data-stage-confirm'] === '',
    )!;
    expect((confirm.props as { variant?: string }).variant).toBe('danger');
    expect((confirm.props as { children?: ReactNode }).children).toBe('Reject');
    (confirm.props as { onClick: () => void }).onClick();
    expect(onConfirm).toHaveBeenCalledOnce();
    const cancel = els.find((el) => (el.props as { children?: ReactNode }).children === 'Cancel')!;
    (cancel.props as { onClick: () => void }).onClick();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('closed when there is no target', () => {
    const tree = StageReasonConfirm({
      copy: null,
      reason: '',
      onReasonChange: () => {},
      onCancel: () => {},
      onConfirm: () => {},
    }) as ReactElement<{ open: boolean }>;
    expect(tree.props.open).toBe(false);
  });

  it('confirm shows the stage now and sends the RPC only in commit, then the reason comment', () => {
    // Reject / park go to the confirm, never straight to the gate.
    expect(PAGE).toMatch(
      /if \(stageReasonConfirm\(to\) !== null\) \{[\s\S]*?setReasonTarget\(to\);\s*return;\s*\}\s*approveGate\.request\(post\.id, to\);/,
    );
    const body = PAGE.slice(PAGE.indexOf('function confirmReasonMove'));
    const optimistic = body.indexOf('setOptimisticStage(to);');
    const run = body.indexOf('runUndoable({');
    const commit = body.indexOf('commit: () => {');
    const runner = body.indexOf('return runStageMoveCommit({');
    const rpc = body.indexOf('await stageTransition(supabase');
    const comment = body.indexOf('postReason: (body) => createAnchoredComment(body, traceId)');
    expect(optimistic).toBeGreaterThan(-1);
    expect(optimistic).toBeLessThan(run);
    // The RPC lives only inside commit (X2: through runStageMoveCommit, whose
    // transition runs first and whose reason comment posts after it).
    expect(commit).toBeLessThan(runner);
    expect(runner).toBeLessThan(rpc);
    expect(rpc).toBeLessThan(comment);
    // Undo restores the old stage locally and sends nothing.
    expect(body).toContain('revert: () => setOptimisticStage(null),');
    expect(PAGE).toContain('const currentStage = optimisticStage ?? (post.stage as Stage);');
  });
});

describe('2. caption and pin comment sheets', () => {
  const caption = read('./pcs/CaptionAnnotationComposer.tsx');
  const pin = read('./pcs/PinAnnotationComposer.tsx');

  it('both are dirty-guarded with the comment discard copy and busy while posting', () => {
    expect(COMMENT_DISCARD).toEqual({
      title: 'Discard this comment?',
      message: 'Your text will be lost.',
    });
    for (const src of [caption, pin]) {
      expect(src).toContain("dirty={body.trim() !== ''}");
      expect(src).toContain('discard={COMMENT_DISCARD}');
      expect(src).toContain('busy={submitting}');
      // No reset on open: the page owns the draft per selection.
      expect(src).not.toContain("if (open) setBody('')");
    }
  });

  it('each selection keeps its own draft key', () => {
    expect(captionDraftKey(2, 9)).not.toBe(captionDraftKey(2, 10));
    expect(pinDraftKey(0, 0.1, 0.2)).not.toBe(pinDraftKey(1, 0.1, 0.2));
  });

  it('the sheet stays open until saved; a failure keeps the text and shows the retry copy', () => {
    expect(COMMENT_POST_FAILED).toBe("Couldn't post your comment. Try again.");
    const submit = PAGE.slice(PAGE.indexOf('async function submitAnnotation'));
    const fail = submit.indexOf('setComposerError(COMMENT_POST_FAILED);');
    const close = submit.indexOf('setComposer(null);');
    expect(fail).toBeGreaterThan(-1);
    // The close comes only after the failure branch returned.
    expect(close).toBeGreaterThan(fail);
    const pinSubmit = PAGE.slice(PAGE.indexOf('async function submitPinAnnotation'));
    expect(pinSubmit.indexOf('setComposerError(COMMENT_POST_FAILED);')).toBeLessThan(
      pinSubmit.indexOf('setPinComposer(null);'),
    );
  });
});

describe('4. gallery writes never overlap', () => {
  it('a second reorder or remove while a save is in flight is dropped', () => {
    expect(PAGE).toContain('if (postId === undefined || gallerySavingRef.current) return false;');
    expect(PAGE).toContain('gallerySavingRef.current = false;');
    expect(PAGE).toContain('saving={gallerySaving}');
  });
});

describe('5. caption edit', () => {
  it('Save names the new version and the note says comments stay', () => {
    expect(captionSaveLabel(3)).toBe('Save as v4');
    expect(captionSaveNote(3)).toBe('Comments on v3 stay with it.');
    expect(captionSaveLabel(null)).toBe('Save');
    expect(captionSaveNote(null)).toBeNull();
  });

  it('Cancel with unsaved edits asks Discard your changes? (Keep editing / Discard)', () => {
    expect(PAGE).toContain('onClick={cancelCaptionEdit}');
    expect(PAGE).toContain('title="Discard your changes?"');
    expect(PAGE).toContain('cancelLabel="Keep editing"');
  });
});

describe('7. small copy and hit areas', () => {
  it('drops every static gallery hint (X2: the visible Add pin and slide ⋯ replace them)', () => {
    expect(PAGE).not.toContain('Tap the menu for actions');
    expect(PAGE).not.toContain('Tap a slide for full screen');
    expect(PAGE).not.toContain('Tap a slide to view it.');
  });

  it('the bucket chip button is at least 44px tall', () => {
    const start = PAGE.indexOf('onClick={() => setShowDetails(true)}');
    expect(PAGE.slice(start, start + 200)).toContain('min-h-[44px]');
  });

  it('the details sheet target date has a Clear that sends null', () => {
    const sheet = read('./pcs/PostDetailsSheet.tsx');
    expect(sheet).toContain('onClick={() => onChangeTargetDate(null)}');
    expect(sheet).toContain('Clear');
  });

  it('no em-dashes in the touched files', () => {
    for (const rel of [
      './PostDetailPage.tsx',
      './pcs/CaptionAnnotationComposer.tsx',
      './pcs/PinAnnotationComposer.tsx',
      './pcs/SlideActionsSheet.tsx',
      './pcs/PostDetailsSheet.tsx',
      './pcs/stage-actions.ts',
    ]) {
      expect(read(rel)).not.toContain('—');
    }
  });
});
