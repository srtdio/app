import { useLayoutEffect, useRef, type ReactElement } from 'react';
import { DrawnMarkGlyph, ICON_SIZE } from '@/components/ui/icons';
import { RESOLVED_FILL_CLASS, RESOLVED_HOLLOW_CLASS } from '@/components/pages/pcs/checkpoint-controls';
import { cn } from '@/lib/cn';
import { drawTick } from '@/lib/motion';

/**
 * The one checkpoint number circle, shared by the comment list (numbered
 * points), the photo pins, the caption highlight, the quote chip and the client
 * slot composer. The circle is the state: nothing else on a row says open or
 * done.
 *
 *   open       ink ring with the number
 *   resolved   good outline with a tick (resolved, the approver has not confirmed)
 *   confirmed  filled good with a tick (resolved and confirmed)
 *   pin        ink dot, no number (an agency pin, not a checkpoint)
 *   next       dashed empty ring with the number (the next free slot)
 *
 * Purely visual (aria-hidden): a tappable caller wraps it in IconButton or a
 * 44x44 box (CHECKPOINT_HIT_CLASS) and names it there.
 */
export type CheckpointCircleState = 'open' | 'resolved' | 'confirmed' | 'pin' | 'next';

/**
 * list: the numbered list column and the pinned progress row.
 * marker: a pin on the photo (the caller owns the 44 hit and the position).
 * inline: inside running text (caption highlight, quote chip).
 */
export type CheckpointCircleSize = 'list' | 'inline' | 'marker';

export interface CheckpointCircleProps {
  /** The checkpoint's ledger_seq. Never renumbered. Ignored for `pin`. */
  n?: number;
  state: CheckpointCircleState;
  size?: CheckpointCircleSize;
  className?: string;
}

/** The 44x44 hit box (and the fixed list column) a circle sits centred in. */
export const CHECKPOINT_HIT_CLASS = 'flex h-11 w-11 shrink-0 items-center justify-center';

// The visible box per size. list and marker share the 28 step (the 4px grid has
// no 26; the strip chips are the same 28); inline is the 16 glyph step.
const BOX: Record<CheckpointCircleSize, string> = {
  list: 'h-7 w-7 text-sm',
  marker: 'h-7 w-7 text-sm',
  inline: 'h-4 w-4 text-xs',
};

// The pin dot: a solid ink disc inside the same box, so a pin lines up with a
// numbered marker beside it.
const PIN_DOT: Record<CheckpointCircleSize, string> = {
  list: 'h-3 w-3',
  marker: 'h-3 w-3',
  inline: 'h-2 w-2',
};

const STATE: Record<CheckpointCircleState, string> = {
  open: 'border-fg bg-panel text-fg',
  resolved: RESOLVED_HOLLOW_CLASS,
  confirmed: RESOLVED_FILL_CLASS,
  pin: 'border-fg bg-panel',
  next: 'border-dashed border-border-strong bg-transparent text-fg-3',
};

function isTick(state: CheckpointCircleState): boolean {
  return state === 'resolved' || state === 'confirmed';
}

export function CheckpointCircle({
  n,
  state,
  size = 'list',
  className,
}: CheckpointCircleProps): ReactElement {
  const ref = useRef<HTMLSpanElement>(null);
  const was = useRef(state);
  // The tick draws once (drawTick) when the circle turns done while on screen;
  // never on first paint, never faded. Colour flips instantly (state, not motion).
  useLayoutEffect(() => {
    const before = was.current;
    was.current = state;
    if (!isTick(state) || isTick(before)) return;
    ref.current?.querySelectorAll('[data-draw]').forEach((path) => {
      drawTick(path);
    });
  }, [state]);
  return (
    <span
      ref={ref}
      aria-hidden
      data-checkpoint-circle={state}
      data-circle-size={size}
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full border font-mono font-medium tabular-nums lit-pill',
        BOX[size],
        STATE[state],
        className,
      )}
    >
      {state === 'pin' ? (
        <span className={cn('rounded-full bg-fg', PIN_DOT[size])} />
      ) : isTick(state) ? (
        <DrawnMarkGlyph
          mark="tick"
          size={size === 'inline' ? ICON_SIZE.text : ICON_SIZE.inline}
        />
      ) : n !== undefined ? (
        n
      ) : null}
    </span>
  );
}

/** The circle state for a checkpoint row: open until resolved, then resolved
 *  (outline) until the approver confirms (filled). */
export function checkpointCircleState(row: {
  resolved_at: string | null;
  accepted_at: string | null;
}): Extract<CheckpointCircleState, 'open' | 'resolved' | 'confirmed'> {
  if (row.resolved_at === null) return 'open';
  return row.accepted_at !== null ? 'confirmed' : 'resolved';
}
