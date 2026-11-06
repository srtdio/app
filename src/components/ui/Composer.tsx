import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { textRole } from '@/components/ui/Text';

/** The composer hint (picked): "Message", or "Reply" while replying. */
export function composerHint(replying: boolean): string {
  return replying ? 'Reply' : 'Message';
}

export type ComposerState =
  | { kind: 'idle' }
  | { kind: 'recording'; elapsed: string }
  | { kind: 'sending' }
  | { kind: 'scheduling' };

export interface ComposerFrameProps {
  /** A 44 slot left of the field (the tray opener, plus). */
  leading?: ReactNode;
  /** The field (ui/Textarea or MentionInput, borderless inside the well). */
  input: ReactNode;
  /** 44 side buttons right of the field: all bare circles, one treatment. */
  side?: ReactNode;
  /** The filled send / mic, always last. */
  send: ReactNode;
  /** Recording: the bin (a 44 danger circle) takes the leading slot. */
  discard?: ReactNode;
  /** The reply / About preview: its own 44 strip above the row, never inside it. */
  strip?: ReactNode;
  state?: ComposerState;
  /** In-field buttons sit flush with the field's right edge (no right padding). */
  flushEnd?: boolean;
  className?: string;
}

/**
 * The composer field's one look: the field line (border-field) a person types
 * into, on the well (bg-panel-2, lit-well); focus adds the focus line.
 */
export const COMPOSER_FIELD =
  'lit-well flex min-h-11 min-w-0 flex-1 items-end rounded-lg border border-field bg-panel-2 pl-4 mv-tint focus-within:lit-focus';

/**
 * The one composer row (chat Composer, CommentComposer, SlotComposer,
 * PersonMessageInput). [leading 44] 8 [input] 8 [side 44]* 8 [send/mic 44].
 * Every state keeps the row: recording swaps the field's contents (dot,
 * "Recording", mm:ss in meta) and the leading slot (the bin); sending puts the
 * spinner in the send slot (the caller's Button busy); scheduling keeps the
 * round shape and reads "Scheduling…" in the field.
 */
export function ComposerFrame({
  leading,
  input,
  side,
  send,
  discard,
  strip,
  state = { kind: 'idle' },
  flushEnd = false,
  className,
}: ComposerFrameProps) {
  const recording = state.kind === 'recording';
  return (
    <div
      data-composer=""
      data-composer-state={state.kind}
      className={cn('flex flex-col gap-2', className)}
    >
      {strip !== undefined ? (
        <div data-composer-strip="" className="flex min-h-11 min-w-0 items-center gap-2">
          {strip}
        </div>
      ) : null}
      <div data-composer-row="" className="flex min-w-0 items-end gap-2">
        {recording ? discard : leading}
        <div
          data-composer-field=""
          className={cn(COMPOSER_FIELD, flushEnd && state.kind === 'idle' ? 'pr-0' : 'pr-4')}
        >
          {state.kind === 'recording' ? (
            <span className="flex min-h-11 min-w-0 flex-1 items-center gap-2">
              <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-bad" />
              <span className={textRole('body', 'flex-1 truncate')}>Recording</span>
              <span className={textRole('meta', 'shrink-0')}>{state.elapsed}</span>
            </span>
          ) : state.kind === 'scheduling' ? (
            <span
              className={textRole('body', 'flex min-h-11 flex-1 items-center truncate text-fg-3')}
            >
              Scheduling…
            </span>
          ) : (
            input
          )}
        </div>
        {recording ? null : side}
        {send}
      </div>
    </div>
  );
}
