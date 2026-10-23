// The approve confirm block outside chat: the same question, consequence line,
// Back and green "Approve" pair the chat post sheet swaps into its footer
// (decision 20 and 22). The copy comes from the chat sheet's own confirmCopy so
// the two never drift. The chat block itself is not exported on its own (it is
// one branch of PostSheetActions, bound to the chat action set), so the markup
// and the button classes are mirrored here; a cleanup PR can fold the chat
// footer onto this component. Hookless and presentational, tokens only, so
// light and dark match. No motion of its own: it rides its host Sheet's
// translateY axis, exactly as the chat confirm does.

import type { ReactElement } from 'react';
import { confirmCopy, postSubject } from '@/components/chat/post-sheet';
import { formatShortDate } from '@/lib/chat/time-format';
import { cn } from '@/lib/cn';

/** 48px buttons, mirroring the chat post sheet's ACTION_BASE. */
const ACTION_BASE =
  'inline-flex h-12 w-full items-center justify-center gap-2 rounded-md px-4 text-sm font-medium select-none transition-colors duration-fast disabled:pointer-events-none disabled:opacity-50';
/** Approve: the solid success fill, so white ink stays readable in dark mode too. */
const ACTION_GOOD = `${ACTION_BASE} bg-good-solid text-white hover:opacity-90`;
const ACTION_GHOST = `${ACTION_BASE} border border-border bg-panel text-fg hover:bg-panel-2`;

/** The target date as the chat confirm prints it ("Oct 2"); empty when not set. */
export function approveTargetDate(targetDate: string | null, timeZone: string): string {
  return targetDate !== null ? formatShortDate(targetDate, timeZone) : '';
}

export interface ApproveConfirmProps {
  /** The post's title; the question names it ("this post" when empty). */
  postTitle: string | null;
  /** Slides on the post; null when the screen has not loaded it (the clause is left out). */
  mediaCount: number | null;
  /** Short target date; empty when not set or not loaded (the clause is left out). */
  targetDate: string;
  /** A failed approve's copy, shown above the buttons as the chat sheet does; absent shows none. */
  error?: string | null;
  /** True while the approve is in flight: both buttons disable, so a double tap sends once. */
  busy: boolean;
  onBack: () => void;
  onConfirm: () => void;
}

/** "Approve <Title>, all N slides, for Oct 2?", its consequence, then Back and Approve. */
export function ApproveConfirm(props: ApproveConfirmProps): ReactElement {
  const copy = confirmCopy('approve', {
    subject: postSubject(props.postTitle),
    mediaCount: props.mediaCount ?? 0,
    targetDate: props.targetDate,
  });
  return (
    <div data-approve-confirm="" className="flex w-full flex-col gap-2">
      <p className="text-sm font-medium text-fg">{copy.question}</p>
      <p className="text-sm text-fg-2">{copy.detail}</p>
      {props.error !== undefined && props.error !== null ? (
        <p role="alert" data-approve-error="" className="text-sm text-bad">
          {props.error}
        </p>
      ) : null}
      <div className="mt-1 flex gap-2">
        <button
          type="button"
          data-approve-back=""
          disabled={props.busy}
          onClick={props.onBack}
          className={cn(ACTION_GHOST, 'flex-1')}
        >
          Back
        </button>
        <button
          type="button"
          data-approve-confirm-button=""
          disabled={props.busy}
          onClick={props.onConfirm}
          className={cn(ACTION_GOOD, 'flex-1')}
        >
          {copy.confirmLabel}
        </button>
      </div>
    </div>
  );
}
