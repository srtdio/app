// The approve confirm block outside chat: Back and the green "Approve" pair,
// above which sits either one quiet summary line ("3 slides · due 20 Jul",
// the post screen, whose sheet title asks "Approve this post?") or the chat
// sheet's question and consequence line (the pipeline's move and drop
// confirms, copy from the chat sheet's confirmCopy so the two never drift).
// The summary never names the post title. Hookless and presentational, tokens
// only, so light and dark match. No motion of its own: it rides its host
// Sheet's translateY axis.

import type { ReactElement } from 'react';
import { confirmCopy, postSubject } from '@/components/chat/post-sheet';
import { Button } from '@/components/ui/Button';
import { formatDay } from '@/lib/display-date';

/** The post screen's approve sheet title: the question, never the post's format or title. */
export const APPROVE_CONFIRM_TITLE = 'Approve this post?';

/** The confirm's buttons. */
export const APPROVE_BACK_LABEL = 'Back';
export const APPROVE_LABEL = 'Approve';

/**
 * The target date in the app's day format ("2 Oct", "4 Jan 2027" outside now's
 * year), read in the workspace zone; empty when not set.
 */
export function approveTargetDate(
  targetDate: string | null,
  timeZone: string,
  now: Date = new Date(),
): string {
  return targetDate !== null ? formatDay(targetDate, timeZone, now) : '';
}

/**
 * The summary line: "3 slides · due 20 Jul", "1 slide", "due 20 Jul", or ''
 * when neither is known. `slides` null or 0 leaves its part out; `dueDay` is the
 * day text approveTargetDate gives ('' leaves it out). Never the post title. Pure.
 */
export function approveConfirmBody(args: { slides: number | null; dueDay: string }): string {
  const parts: string[] = [];
  if (args.slides !== null && args.slides > 0) {
    parts.push(`${args.slides} ${args.slides === 1 ? 'slide' : 'slides'}`);
  }
  if (args.dueDay !== '') parts.push(`due ${args.dueDay}`);
  return parts.join(' · ');
}

export interface ApproveConfirmProps {
  /** The post's title; only the 'question' mode names it ("this post" when empty). */
  postTitle: string | null;
  /** Slides on the post; null when the screen has not loaded it (the part is left out). */
  mediaCount: number | null;
  /** Short target date; empty when not set or not loaded (the part is left out). */
  targetDate: string;
  /**
   * 'summary' (the post screen): one line "{n} slides · due {date}" under a
   * sheet titled {@link APPROVE_CONFIRM_TITLE}. 'question' (default, the
   * pipeline): the chat sheet's question and consequence line.
   */
  mode?: 'question' | 'summary';
  /** A failed approve's copy, shown above the buttons as the chat sheet does; absent shows none. */
  error?: string | null;
  /** True while the approve is in flight: both buttons disable, so a double tap sends once. */
  busy: boolean;
  onBack: () => void;
  onConfirm: () => void;
  /** The guided-tour key set on the Approve button (data-induction); absent sets none. */
  induction?: string;
}

/** The summary line or the chat question, an optional error, then Back and Approve. */
export function ApproveConfirm(props: ApproveConfirmProps): ReactElement {
  let lines: ReactElement | null;
  if (props.mode === 'summary') {
    const body = approveConfirmBody({ slides: props.mediaCount, dueDay: props.targetDate });
    lines =
      body !== '' ? (
        <p data-approve-summary="" className="text-legacy-sm text-fg-2">
          {body}
        </p>
      ) : null;
  } else {
    const copy = confirmCopy('approve', {
      subject: postSubject(props.postTitle),
      mediaCount: props.mediaCount ?? 0,
      targetDate: props.targetDate,
    });
    lines = (
      <>
        <p className="text-legacy-sm font-medium text-fg">{copy.question}</p>
        <p className="text-legacy-sm text-fg-2">{copy.detail}</p>
      </>
    );
  }
  return (
    <div data-approve-confirm="" className="flex w-full flex-col gap-2">
      {lines}
      {props.error !== undefined && props.error !== null ? (
        <p role="alert" data-approve-error="" className="text-legacy-sm text-bad">
          {props.error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button
          type="button"
          variant="secondary"
          data-approve-back=""
          disabled={props.busy}
          onClick={props.onBack}
          className="min-w-[44px] flex-1"
        >
          {APPROVE_BACK_LABEL}
        </Button>
        <Button
          type="button"
          variant="success"
          data-approve-confirm-button=""
          {...(props.induction !== undefined ? { 'data-induction': props.induction } : {})}
          disabled={props.busy}
          onClick={props.onConfirm}
          className="min-w-[44px] flex-1"
        >
          {APPROVE_LABEL}
        </Button>
      </div>
    </div>
  );
}
