// The post decision row (T12 / FN8, flow B 30 / 33). One model, two places,
// the same on Post detail and the chat post sheet (usePostDecisions builds the
// model for both): PostDecisionBar pins it to the bottom on phone, and
// PostDecisionRow renders the same row at the right of the detail header on
// laptop (useIsLaptop). The host renders exactly one of them per breakpoint.
//
// Approvers in review: Reject (secondary, bad ink) then Approve (success green),
// in that order everywhere; no Comment button (the composer is on the page). Creators: one main button ("Send for
// review", or "Send for review again"); their other moves (Approve on their
// behalf, Park, Reject) live in the post's ⋯ menu. The buttons are words
// only, never icons (the ⋯ menu rows keep theirs). A failed tap
// shows its plain-words error here, once. Hookless, so the tree is unit tested
// by walking it. The page reserves room under its content so the bar never
// covers the comment composer.

import type { ReactElement, ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { ErrorNote } from '@/components/ui/ErrorNote';
import { INDUCTION_KEYS } from '@/lib/induction';
import { bottomAnchorProps } from '@/lib/bottom-inset';
import type { StageAction } from '@/components/pages/pcs/stage-actions';
import type { Stage } from '@srtdio/posts';

/** Height the page reserves under its content for a plain bar (px, plus the safe area). */
export const DECISION_BAR_SPACE_PX = 76;

/** The creator's main button in review (flow B 33). */
export const SEND_AGAIN_LABEL = 'Send for review again';

/**
 * The approver row order (flow B 30): Reject first, Approve last, anything
 * else between, each group keeping its order. Pure.
 */
export function decisionBarOrder(actions: readonly StageAction[]): StageAction[] {
  const rank = (action: StageAction): number =>
    action.to === 'rejected' ? 0 : action.to === 'approved' ? 2 : 1;
  return [...actions].sort((a, b) => rank(a) - rank(b));
}

/** What the decision row shows: the approver's choices, or the creator's one main button. */
export type DecisionModel =
  | {
      kind: 'approver';
      actions: readonly StageAction[];
      onPick: (to: Stage) => void;
    }
  | {
      kind: 'creator';
      label: string;
      disabled: boolean;
      /**
       * A quiet line under the button, or null. "Send for review again" never
       * carries one: open comments ask to confirm, they never block (flow B 33).
       */
      helper: string | null;
      onPress: () => void;
    };

/** Room the phone bar needs under the page for this model and error (px, before the safe area). */
export function decisionBarSpace(model: DecisionModel | null, error: string | null): number {
  let space = DECISION_BAR_SPACE_PX;
  if (model?.kind === 'creator' && model.helper !== null) space += 24;
  if (error !== null) space += 52;
  return space;
}

function approverButtons(
  model: Extract<DecisionModel, { kind: 'approver' }>,
  busy: boolean,
): ReactNode {
  const ordered = decisionBarOrder(model.actions);
  return (
    <div className="flex items-center gap-2">
      {ordered.map((action) => {
        const approve = action.to === 'approved';
        return (
          <Button
            key={action.to}
            variant={approve ? 'success' : 'secondary'}
            disabled={busy}
            onClick={() => model.onPick(action.to)}
            {...(approve ? { 'data-induction': INDUCTION_KEYS.postApprove } : {})}
            className={
              action.to === 'rejected' ? 'min-w-[44px] flex-1 text-bad' : 'min-w-[44px] flex-1'
            }
          >
            {action.label}
          </Button>
        );
      })}
    </div>
  );
}

function creatorButton(
  model: Extract<DecisionModel, { kind: 'creator' }>,
  busy: boolean,
): ReactNode {
  return (
    <div className="flex flex-col gap-1.5">
      <Button
        variant="primary"
        data-decision-main=""
        disabled={model.disabled || busy}
        onClick={model.onPress}
        className="w-full"
      >
        {model.label}
      </Button>
      {model.helper !== null ? (
        <p data-decision-helper="" className="text-center text-sm text-fg-3">
          {model.helper}
        </p>
      ) : null}
    </div>
  );
}

/** The row's content: the error (once, plain words) above the buttons. */
function decisionContent(
  model: DecisionModel | null,
  busy: boolean,
  error: string | null,
): ReactNode {
  return (
    <>
      {error !== null ? (
        // The data hook sits on a wrapper: ErrorNote takes no extra props.
        <div data-decision-error="" className="mb-2">
          <ErrorNote>{error}</ErrorNote>
        </div>
      ) : null}
      {model === null
        ? null
        : model.kind === 'approver'
          ? approverButtons(model, busy)
          : creatorButton(model, busy)}
    </>
  );
}

/** Whether there is anything to show: a model with a button, or an error. Pure. */
export function hasDecisionContent(model: DecisionModel | null, error: string | null): boolean {
  if (error !== null) return true;
  if (model === null) return false;
  return model.kind === 'creator' || model.actions.length > 0;
}

/**
 * The phone bar. 'fixed' (a page): pinned above the safe area, below md only.
 * 'footer' (a sheet): the same row filling the host Sheet's footer, which is
 * already pinned to the bottom and pads for the safe area. Either way the phone
 * Undo strip floats above it (the bar, or the Sheet footer, is an undo anchor).
 */
export function PostDecisionBar(props: {
  model: DecisionModel | null;
  busy: boolean;
  error: string | null;
  placement?: 'fixed' | 'footer';
}): ReactElement | null {
  if (!hasDecisionContent(props.model, props.error)) return null;
  if (props.placement === 'footer') {
    return (
      <div data-decision-bar="" className="w-full">
        {decisionContent(props.model, props.busy, props.error)}
      </div>
    );
  }
  return (
    <div
      data-decision-bar=""
      {...bottomAnchorProps}
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-panel px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] md:hidden"
    >
      {decisionContent(props.model, props.busy, props.error)}
    </div>
  );
}

/** The same row inline: the laptop header's right side, or the embedded page's decision slot. */
export function PostDecisionRow(props: {
  model: DecisionModel | null;
  busy: boolean;
  error: string | null;
  /** A quiet line above the buttons (the approver's review note), or null. */
  note?: string | null;
}): ReactElement | null {
  const note = props.note ?? null;
  if (!hasDecisionContent(props.model, props.error) && note === null) return null;
  return (
    <div data-decision-row="" className="flex flex-col">
      {note !== null ? <p className="mb-3 text-base text-fg-2">{note}</p> : null}
      {decisionContent(props.model, props.busy, props.error)}
    </div>
  );
}
