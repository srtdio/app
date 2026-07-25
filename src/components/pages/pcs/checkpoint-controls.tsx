// Checkpoint control primitives shared by whatever renders checkpoint controls
// (today the comment feed; anything else later). These were never ledger-specific
// and moved here verbatim from the former FeedbackLedger so the source lives with
// the controls, not with any one surface that draws them.

import type { ReactElement } from 'react';
import { IconCheck } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import type { CommentResolveArgs, DomainError } from '@srtdio/rpc';

/** The proc trims and caps the note at 500 chars; the input mirrors the cap. */
export const MAX_NOTE_CHARS = 500;
export const NOTE_PLACEHOLDER = 'What changed (optional, client sees this)';

/**
 * Build the comment_resolve args. The note rides as p_resolution_note ONLY on a
 * resolve (the proc ignores it on reopen and only stores it on a real
 * open-to-resolved transition); a blank note is omitted entirely so the proc's
 * trim-to-null never even sees it. trace is always explicit.
 */
export function buildResolveArgs(input: {
  commentId: string;
  resolved: boolean;
  note?: string;
  traceId: string;
}): CommentResolveArgs {
  const trimmed = input.note?.trim() ?? '';
  return {
    p_comment_id: input.commentId,
    p_resolved: input.resolved,
    p_trace_id: input.traceId,
    ...(input.resolved && trimmed !== '' ? { p_resolution_note: trimmed } : {}),
  };
}

/** Friendly inline copy for a failed comment_resolve. */
export function friendlyResolveError(error: DomainError): string {
  switch (error.code) {
    case 'invalid_payload':
      return `Could not save. Notes are limited to ${MAX_NOTE_CHARS} characters.`;
    case 'forbidden_role':
    case 'workspace_member_only':
      return 'You do not have permission to make this change.';
    default:
      return 'Something went wrong. Please try again.';
  }
}

/** Friendly inline copy for a failed checkpoint_accept. invalid_stage sits outside
 *  DOMAIN_ERROR_CODES so it arrives as the raw message; the rest map by code, the
 *  same split runPostReadyNotify uses for its ledger-specific raises. */
export function friendlyAcceptError(error: DomainError): string {
  if (error.message === 'invalid_stage') return 'This checkpoint is not ready to confirm yet.';
  switch (error.code) {
    case 'invalid_payload':
      return 'This is not a checkpoint.';
    case 'forbidden_role':
    case 'workspace_member_only':
      return 'Only the client can confirm a checkpoint.';
    default:
      return 'Something went wrong. Please try again.';
  }
}

/** The tick circle. The check enters/leaves via opacity/translateY only, per the
 *  motion tokens; the fill flips instantly (colour is state, not motion). When
 *  `live` (the client's turn, an unfilled circle), the ring/border switches to the
 *  accent line so the circle reads as the one thing to act on. */
export function tickCircle(done: boolean, live = false): ReactElement {
  return (
    <span
      className={cn(
        'flex h-6 w-6 items-center justify-center rounded-full border',
        done ? 'border-good bg-good text-white' : 'border-border text-transparent',
        live && !done ? 'border-accent-line ring-2 ring-accent' : '',
      )}
    >
      <span
        className={cn(
          // axis: opacity + translateY only (no translateX, rotate, scale)
          'transition-[opacity,transform] duration-fast ease-enter',
          done ? 'translate-y-0 opacity-100' : 'translate-y-0.5 opacity-0',
        )}
      >
        <IconCheck size={14} />
      </span>
    </span>
  );
}

/** Note-input reveal classes: opacity/translateY only (the Sheet enter pattern). */
export function noteRevealClass(entered: boolean): string {
  return cn(
    // axis: opacity + translateY only (no translateX, rotate, scale)
    'transition-[opacity,transform] duration-fast ease-enter',
    entered ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0',
  );
}
