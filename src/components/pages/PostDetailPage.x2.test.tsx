import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';

// The page's import graph pulls the real agora-chat browser SDK. Mock it so
// importing the hookless pieces in node never touches browser globals.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { StageReasonConfirm } from '@/components/pages/PostDetailPage';
import { stageReasonConfirm } from '@/components/pages/pcs/stage-actions';

// X2 regressions. node environment, no DOM: hookless trees are walked, and the
// wiring that lives inside hooks is pinned against the source.

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const PAGE = read('./PostDetailPage.tsx');
const DETAILS = read('./pcs/PostDetailsSheet.tsx');
const SLIDE_ACTIONS = read('./pcs/SlideActionsSheet.tsx');
const VERSION_HISTORY = read('./pcs/VersionHistorySheet.tsx');

function walk(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    node.forEach((child) => walk(child, out));
    return out;
  }
  if (node === null || typeof node !== 'object' || !('props' in node)) return out;
  const el = node as ReactElement;
  out.push(el);
  walk((el.props as { children?: ReactNode }).children, out);
  return out;
}

describe('1. caption block (mock P1)', () => {
  it('reads like the post: workspace row, platform · format · vN, a text Edit with pencil', () => {
    const block = PAGE.slice(PAGE.indexOf('data-caption-block=""'));
    expect(block).toContain('<Avatar name={workspaceName ?? \'\'} size="md" />');
    expect(block).toContain('{platformLabel(post.platform)} · {formatLabel(post.format)}');
    expect(block).toContain('<VersionPill');
    expect(block).toContain('data-caption-edit=""');
    expect(block).toContain('<IconPencil size={15} />\n                    Edit');
    // The uppercase eyebrow and the select hint are gone.
    expect(PAGE).not.toContain('>\n                  Caption\n                </span>');
    expect(PAGE).not.toContain('Select any text to comment on it.');
  });

  it('shows the one-time tip with a 44px Got it, dismissed per user through the guarded storage helper', () => {
    expect(PAGE).toContain('<span>{CAPTION_TIP_TEXT}</span>');
    expect(PAGE).toContain('dismissCaptionTip(userId);');
    expect(PAGE).toContain('setCaptionTipOpen(!captionTipDismissed(userId));');
    const tip = PAGE.slice(PAGE.indexOf('data-caption-tip=""'));
    expect(tip.slice(0, 900)).toContain('min-h-[44px] min-w-[44px]');
    expect(tip.slice(0, 900)).toContain('Got it');
  });
});

describe('2 / 5. comments header, stage section once, sticky bar', () => {
  it('drops the phone Feedback h2 and the Comments eyebrow; Comments own the header and the strip', () => {
    expect(PAGE).not.toContain('>Feedback</h2>');
    expect(PAGE).not.toContain('>\n                  Comments\n                </span>');
    expect(PAGE).toContain('showHeader');
    expect(PAGE).toMatch(/belowHeader=\{\s*<CheckpointStrip/);
  });

  it('renders the stage section exactly once (one conditional), so role=alert never duplicates', () => {
    expect(PAGE).not.toContain('<div className="md:hidden">{stageSection}</div>');
    expect(PAGE).not.toContain('<div className="hidden md:block">{stageSection}</div>');
    expect(PAGE.split('{phoneLayout ? null : stageSection}')).toHaveLength(2);
    expect(PAGE.split('{phoneLayout ? phoneStageNotes : null}')).toHaveLength(2);
    expect(PAGE).toContain('const phoneLayout = !isDesktop && !embedded;');
  });

  it('the phone bar is the pcs PostDecisionBar, only off read-only, with room reserved under the page', () => {
    expect(PAGE).toContain('phoneLayout && !readOnly ? (');
    expect(PAGE).toContain(
      '<PostDecisionBar actions={stageActions} transitioning={transitioning} onPick={pickStage} />',
    );
    expect(PAGE).toContain('data-decision-bar-space=""');
    expect(PAGE).toContain('calc(${DECISION_BAR_SPACE_PX}px + env(safe-area-inset-bottom))');
  });

  it('FN10: stage buttons stay enabled during the undo window and a pick flushes the pending commit', () => {
    expect(PAGE).toContain(
      '<StageButtons actions={stageActions} transitioning={transitioning} onPick={pickStage} />',
    );
    expect(PAGE).not.toContain('transitioning={transitioning || optimisticStage !== null}');
    expect(PAGE).toMatch(
      /function pickStage\(to: Stage\): void \{\s*if \(optimisticStage !== null\) flushUndoable\(\);/,
    );
  });
});

describe('6. gallery hints and slide actions', () => {
  it('the static hint line is gone and the slide sheet offers Make first / Make last', () => {
    expect(PAGE).not.toContain('Long-press to place a pin.');
    expect(PAGE).toContain(
      'onMakeFirst={() => {\n          if (slideIndex !== null) handleMakeFirst(slideIndex);',
    );
    expect(PAGE).toContain(
      'onMakeLast={() => {\n          if (slideIndex !== null) handleMakeLast(slideIndex);',
    );
    expect(SLIDE_ACTIONS).toContain('label="Make first"');
    expect(SLIDE_ACTIONS).toContain('label="Make last"');
  });
});

describe('7. FB6 reject / park commit', () => {
  it('captures the app-wide toast once in a ref, exactly as PipelinePage does, and drops the page stack', () => {
    expect(PAGE).toContain('const toastApi = useOptionalToast();');
    expect(PAGE).toContain('const toastRef = useRef(toastApi);');
    expect(PAGE).toContain('toastRef.current = toastApi;');
    expect(PAGE).toContain('toastRef.current?.show({ title: message });');
    expect(PAGE).not.toContain('useToasts(');
    expect(PAGE).not.toContain('<Toasts ');
  });

  it('the commit runs through runStageMoveCommit with the app-wide toast, Open, document and no rethrow', () => {
    const body = PAGE.slice(
      PAGE.indexOf('function confirmReasonMove'),
      PAGE.indexOf('function leave'),
    );
    expect(body).toContain('return runStageMoveCommit({');
    expect(body).toContain('toast: toastRef.current,');
    expect(body).toContain('openPost: () => navigate(`/posts/${movedPostId}`),');
    expect(body).toContain('doc: document,');
    expect(body).toContain(
      'stillHere: () => mountedRef.current && postIdRef.current === movedPostId,',
    );
    expect(body).toContain('setInlineError: setActionError,');
    expect(body).toContain(
      'isDomainError(error) ? friendlyTransitionError(error) : plainError(error)',
    );
    expect(body).not.toMatch(/\bthrow\b/);
  });

  it('mountedRef is declared before useUndoableAction so its cleanup runs before the unmount flush', () => {
    const mounted = PAGE.indexOf('const mountedRef = useRef(false);');
    const hook = PAGE.indexOf('useUndoableAction();');
    expect(mounted).toBeGreaterThan(-1);
    expect(mounted).toBeLessThan(hook);
  });
});

describe('8 / 9 / 10. reason sheet dirty, Back, delete', () => {
  it('FT12: the reason sheet is dirty once a reason is typed, with its own discard copy', () => {
    const clean = StageReasonConfirm({
      copy: stageReasonConfirm('rejected'),
      reason: '   ',
      onReasonChange: () => {},
      onCancel: () => {},
      onConfirm: () => {},
    }) as ReactElement<{ dirty: boolean; discard: { title: string } }>;
    expect(clean.props.dirty).toBe(false);
    const typed = StageReasonConfirm({
      copy: stageReasonConfirm('parked'),
      reason: 'Hold for launch',
      onReasonChange: () => {},
      onCancel: () => {},
      onConfirm: () => {},
    }) as ReactElement<{ dirty: boolean; discard: { title: string; message: string } }>;
    expect(typed.props.dirty).toBe(true);
    expect(typed.props.discard).toEqual({
      title: 'Discard your reason?',
      message: 'Your reason will be lost.',
    });
    expect(walk(typed).length).toBeGreaterThan(0);
  });

  it('FT13: Back goes one step back when there is in-app history, else /pipeline', () => {
    const body = PAGE.slice(
      PAGE.indexOf('function leave(): void'),
      PAGE.indexOf('function goPipeline'),
    );
    expect(body).toContain('if (hasInAppHistory(window.history.state)) navigate(-1);');
    expect(body).toContain('else goPipeline();');
    expect(PAGE).toContain('onClick={goPipeline}');
    // The one hard navigation to the pipeline, still gated by onNavigateAway.
    expect(PAGE.match(/navigate\('\/pipeline'\)/g)).toHaveLength(1);
  });

  it('FT14: delete is a 4s undoable ("Post deleted"), leaves as the commit starts, honest copy', () => {
    const body = PAGE.slice(
      PAGE.indexOf('async function handleDeletePost'),
      PAGE.indexOf('const applyPostUpdate'),
    );
    expect(body).toContain("label: 'Post deleted',");
    expect(body).toContain('if (mountedRef.current && postIdRef.current === deletedId) leave();');
    expect(body).toContain('await postSoftDelete(supabase');
    expect(body).toContain('showWhenVisible(document, () => {');
    expect(body).not.toContain('Could not delete this post');
    expect(read('./pcs/PostActionSheet.tsx')).toContain(
      "DELETE_CONFIRM_BASE = 'Delete this post? Moves to Recently deleted.'",
    );
  });
});

describe('11. FN7 / FN9 / FN11 copy', () => {
  it('version history uses the app formatter, title edit shows Save / Cancel on touch, settings path copy', () => {
    expect(VERSION_HISTORY).toContain("import { shortDate } from '@/lib/relative-time';");
    expect(VERSION_HISTORY).not.toContain('toLocaleString()');
    expect(PAGE).toContain('{isTouchDevice() ? (');
    expect(PAGE).toContain('onPointerDown={(event) => event.preventDefault()}');
    expect(DETAILS).toContain('Create them in Settings &gt; Workspace.');
    expect(DETAILS).not.toContain('Workspace settings');
  });
});

describe('13 / 14. skeleton and load error', () => {
  it('Loading post is a skeleton with a screen-reader label, never bare text', () => {
    const paint = PAGE.slice(PAGE.indexOf('if (loading) {'), PAGE.indexOf('if (loadError) {'));
    expect(paint).toContain('aria-busy="true"');
    expect(paint).toContain('<span className="sr-only">Loading post</span>');
    expect(paint).toContain('animate-pulse');
  });

  it('FT3: a failed load is ui/LoadError ("Couldn\'t load this post.") with Retry; the raw message is only logged', () => {
    expect(PAGE).toContain('<LoadError title="this post" onRetry={() => void load()} />');
    expect(PAGE).not.toContain('Could not load this post');
    expect(PAGE).toContain(
      "logger.warn('post page: load failed', { error: result.error.message });",
    );
    expect(PAGE).toContain('const [loadError, setLoadError] = useState(false);');
  });
});

describe('15. FB8 workspace-zone date', () => {
  it('the owner / date line and the details sheet read the day in the workspace zone', () => {
    expect(PAGE).toContain('formatPostTargetDate(post.target_date, approveTimeZone)');
    expect(PAGE).not.toContain('toLocaleDateString');
    expect(PAGE).toContain('timeZone={approveTimeZone}');
    expect(DETAILS).toContain('targetDateInputValue(targetDate, timeZone)');
    expect(DETAILS).toContain(
      'onChangeTargetDate(targetDateFromInput(event.target.value, timeZone))',
    );
    expect(DETAILS).not.toContain('toISOString().slice(0, 10)');
  });
});
