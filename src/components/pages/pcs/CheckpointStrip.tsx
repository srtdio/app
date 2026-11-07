// The post's checkpoint progress row: one circle per checkpoint comment (its
// ledger_seq, or a tick once resolved) and the progress text "{n} of {m}
// resolved" (checkpointProgressText). It is part of the post screen's pinned
// block, directly under the exit bar (ui/HeaderBar `below`), so it stays on
// screen while the page scrolls; the floating sticky strip inside the comments
// card is retired. The read and the live state are one hook
// (useCheckpointProgress): the host's shared checkpoint read (or its own), with
// the comments list's live state (LiveCheckpointsContext, optimistic taps
// included) laid over it. The component is mounted inside the comments list
// (belowHeader, where that context lives) and portals the row into the pinned
// slot, so the context reaches it with no second read. Tapping a circle scrolls
// to and flashes that checkpoint's row in the feed (flashNode). No checkpoint
// text and no controls live here. No checkpoints: nothing renders.

import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconButton } from '@/components/ui/IconButton';
import type { ReactElement } from 'react';
import {
  checkpointProgressText,
  commentDomId,
  LiveCheckpointsContext,
} from '@/components/comments/Comments';
import type { LiveCheckpoint } from '@/components/comments/Comments';
import { flashNode } from '@/components/comments/flash-node';
import {
  RESOLVED_FILL_CLASS,
  RESOLVED_HOLLOW_CLASS,
} from '@/components/pages/pcs/checkpoint-controls';
import { ICON_SIZE, IconCheck } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { GUTTER } from '@/components/ui/layout';
import { supabase } from '@/lib/supabase';
import type { CommentRow } from '@srtdio/comments';

/** The chip read: only the columns the chips and counter derive from. No bodies,
 *  mentions or attachments; the feed owns all of that. Ordered by ledger_seq via
 *  the query. */
export const CHECKPOINT_SELECT = 'id, ledger_seq, resolved_at, accepted_at';

/** One checkpoint as the strip selects it. */
export type CheckpointChipRow = Pick<
  CommentRow,
  'id' | 'ledger_seq' | 'resolved_at' | 'accepted_at'
>;

/** A row of the host's shared checkpoint read (Comments' fetchCheckpoints):
 *  soft-deleted checkpoints ride along there, so the strip drops them. */
export type SharedCheckpointRow = CheckpointChipRow & Pick<CommentRow, 'deleted_at'>;

/** The chips from the host's shared read: live checkpoints only, the chip
 *  columns only (the same rows the strip's own read selects). Pure. */
function chipRowsFrom(rows: readonly SharedCheckpointRow[]): CheckpointChipRow[] {
  return rows
    .filter((row) => row.deleted_at === null && row.ledger_seq !== null)
    .map((row) => ({
      id: row.id,
      ledger_seq: row.ledger_seq,
      resolved_at: row.resolved_at,
      accepted_at: row.accepted_at,
    }));
}

/** The lifted counts PostDetailPage consumes for its header chip and tab badge.
 *  The shape is unchanged from the former LedgerCounts; only the name reflects
 *  that the source is now the strip, not a ledger. */
export interface CheckpointCounts {
  resolved: number;
  total: number;
}

/** Resolved counts every checkpoint whose resolved_at is not null, against the
 *  total number of checkpoints. */
export function checkpointCounts(
  rows: readonly Pick<CheckpointChipRow, 'resolved_at'>[],
): CheckpointCounts {
  return {
    resolved: rows.filter((row) => row.resolved_at !== null).length,
    total: rows.length,
  };
}

/**
 * The chip's VISIBLE state: 'open' while unresolved, 'resolved' once resolved_at
 * is set. The DB's accepted_at stays as it is but never shows as a third state;
 * an agency reopen (resolved_at back to null) drops a chip straight to 'open'.
 */
type ChipState = 'open' | 'resolved';
export function chipState(row: Pick<CheckpointChipRow, 'resolved_at'>): ChipState {
  return row.resolved_at === null ? 'open' : 'resolved';
}

/** The visible circle's treatment per state, from design tokens only so light and
 *  dark parity is automatic: a resolved chip the approver has confirmed fills with
 *  the shared success fill and its on-colour ink token; a resolved chip not yet
 *  confirmed is the shared hollow tick (same word, no fill); open uses the muted
 *  panel treatment. `confirmed` defaults to true (the filled look). */
export function chipCircleClass(state: ChipState, confirmed = true): string {
  if (state === 'open') return 'border-border bg-panel-2 text-fg-3';
  return confirmed ? RESOLVED_FILL_CLASS : RESOLVED_HOLLOW_CLASS;
}

/** A copy sorted by ledger_seq ascending. The query already orders; this keeps
 *  the render order-stable regardless of read order and self-contained for tests. */
function byLedgerSeq(rows: readonly CheckpointChipRow[]): CheckpointChipRow[] {
  return [...rows].sort((a, b) => (a.ledger_seq ?? 0) - (b.ledger_seq ?? 0));
}

/** One chip per checkpoint, ledger_seq ascending. Each chip is the shared
 *  IconButton: a 44x44 touch target (the visible circle is smaller) and an accessible
 *  label naming the checkpoint it jumps to; activating it scrolls to and rings
 *  that checkpoint's row in the feed. A resolved chip shows a tick glyph in place
 *  of its number. */
export function checkpointChips(rows: readonly CheckpointChipRow[]): ReactElement[] {
  return byLedgerSeq(rows).map((row) => {
    const state = chipState(row);
    const seq = row.ledger_seq ?? 0;
    return (
      <IconButton
        key={row.id}
        label={`Jump to checkpoint ${seq}`}
        onClick={() => flashNode(commentDomId(row.id))}
        // axis: none. The chip's own markup never translates, rotates or scales;
        // the only motion is IconButton's shared press feedback.
        className="shrink-0"
      >
        <span
          aria-hidden
          data-chip-tick={
            state === 'open' ? 'open' : row.accepted_at !== null ? 'filled' : 'hollow'
          }
          className={cn(
            'flex h-7 w-7 items-center justify-center rounded-full border font-mono text-sm font-medium tabular-nums lit-pill',
            chipCircleClass(state, row.accepted_at !== null),
          )}
        >
          {state === 'open' ? seq : <IconCheck size={ICON_SIZE.inline} />}
        </span>
      </IconButton>
    );
  });
}

/** Overlay the comments list's live state onto the strip's own read. Pure. */
function withLiveState(
  rows: readonly CheckpointChipRow[],
  live: ReadonlyMap<string, LiveCheckpoint> | null,
): CheckpointChipRow[] {
  if (live === null) return [...rows];
  return rows.map((row) => {
    const state = live.get(row.id);
    return state === undefined
      ? row
      : { ...row, resolved_at: state.resolved_at, accepted_at: state.accepted_at };
  });
}

export interface CheckpointProgressInput {
  workspaceId: string;
  postId: string;
  /** Bumped by the page (shared with Comments) to refetch. */
  refreshSignal: number;
  /** Lifted counts so the page renders its header chip without a second fetch. */
  onCounts?: (counts: CheckpointCounts) => void;
  /**
   * The host's one checkpoint read (PostDetailPage, shared with Comments); null
   * until it lands. When set the hook never reads on its own and the host
   * owns every refresh. Absent: the hook reads itself, as before.
   */
  checkpoints?: readonly SharedCheckpointRow[] | null;
}

/**
 * The checkpoint progress read and live state: the rows to draw (ledger_seq
 * order, live state laid over) and their counts. Must run under the comments
 * list (LiveCheckpointsContext) so a Resolve, Confirm or Undo repaints a circle
 * in the same render as its row; outside it the read alone shows.
 */
export function useCheckpointProgress({
  workspaceId,
  postId,
  refreshSignal,
  onCounts,
  checkpoints,
}: CheckpointProgressInput): { rows: CheckpointChipRow[]; counts: CheckpointCounts } {
  const [ownRows, setRows] = useState<CheckpointChipRow[]>([]);
  const [ownLoaded, setLoaded] = useState(false);
  const shared = checkpoints !== undefined;
  const sharedRows = useMemo(
    () => (checkpoints === undefined || checkpoints === null ? null : chipRowsFrom(checkpoints)),
    [checkpoints],
  );
  const rows = shared ? (sharedRows ?? ownRows) : ownRows;
  const loaded = shared ? sharedRows !== null : ownLoaded;

  // Switching posts drops the prior rows so nothing bleeds across.
  useEffect(() => {
    setRows([]);
    setLoaded(false);
  }, [postId]);

  // Self-fetch, mirroring the feed: one plain RLS-scoped select of this post's
  // checkpoint rows, narrowed to the columns the circles and counter need. One
  // query, never a query inside a loop. A failed read keeps whatever was shown.
  // A host-owned read (checkpoints set) replaces it: no read here.
  const load = useCallback(async (): Promise<void> => {
    if (shared) return;
    const { data, error } = await supabase
      .from('comments')
      .select(CHECKPOINT_SELECT)
      .eq('workspace_id', workspaceId)
      .eq('entity_type', 'post')
      .eq('entity_id', postId)
      .not('ledger_seq', 'is', null)
      .is('deleted_at', null)
      .order('ledger_seq', { ascending: true });
    if (error) return;
    setRows(data ?? []);
    setLoaded(true);
  }, [workspaceId, postId, shared]);

  useEffect(() => {
    void load();
  }, [load]);

  // A refreshSignal bump refetches; the mount load covers the initial value.
  const lastSignal = useRef(refreshSignal);
  useEffect(() => {
    if (lastSignal.current === refreshSignal) return;
    lastSignal.current = refreshSignal;
    void load();
  }, [refreshSignal, load]);

  // The comments list's live state (its optimistic Resolve / Reopen / Confirm /
  // Undo included) wins over this read, so a circle changes in the same paint as
  // the row and the header count. No refetch.
  const live = useContext(LiveCheckpointsContext);
  const shown = useMemo(() => withLiveState(rows, live), [rows, live]);
  const counts = useMemo(() => checkpointCounts(shown), [shown]);

  // Lift the counts once a fetch has landed so the page chip / tab badge stay
  // derived from this one read.
  useEffect(() => {
    if (!loaded) return;
    onCounts?.(counts);
  }, [counts, loaded, onCounts]);

  return { rows: shown, counts };
}

/**
 * The row itself: the circles (horizontal scroll only, never wrapping, so a
 * twenty-point post stays one 48px row) and "{n} of {m} resolved". `pinned`
 * (under the exit bar): the page gutter and a top hairline, the bar's block
 * carrying the surface and its lit-header; in place (embedded): no edge of its
 * own. Pure.
 */
export function CheckpointProgressRow({
  rows,
  counts,
  pinned,
}: {
  rows: readonly CheckpointChipRow[];
  counts: CheckpointCounts;
  pinned: boolean;
}): ReactElement {
  return (
    <div
      data-checkpoint-progress-row=""
      className={cn('flex h-12 min-w-0 items-center', pinned && cn('border-t', GUTTER))}
    >
      {/* axis: horizontal scroll only (overflow-x). Never overflow-y, never wrap. */}
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {checkpointChips(rows)}
      </div>
      <span
        data-checkpoint-progress=""
        className="ml-2 shrink-0 self-center text-sm tabular-nums text-fg-3"
      >
        {checkpointProgressText(counts.resolved, counts.total)}
      </span>
    </div>
  );
}

export interface CheckpointProgressProps extends CheckpointProgressInput {
  /**
   * The pinned slot under the screen's exit bar (HeaderBar `below`): the row
   * portals into it. null while the slot is not mounted or the section is
   * still hidden behind the first-paint skeleton: nothing renders. Absent
   * (embedded in a plan item, no bar of its own): the row renders in place.
   */
  target?: HTMLElement | null;
}

/** The progress row, wherever the host pins it. Nothing when there are no checkpoints. */
export function CheckpointProgress({
  target,
  ...input
}: CheckpointProgressProps): ReactElement | null {
  const { rows, counts } = useCheckpointProgress(input);
  if (rows.length === 0) return null;
  if (target === undefined) {
    return <CheckpointProgressRow rows={rows} counts={counts} pinned={false} />;
  }
  if (target === null) return null;
  return createPortal(<CheckpointProgressRow rows={rows} counts={counts} pinned />, target);
}
