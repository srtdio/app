// The checkpoint strip on PCS: a sticky, single-row index of the post's
// checkpoint comments. The comment feed now owns every checkpoint's body, state
// and controls; the strip is only a jump index into it. It shows one chip per
// checkpoint (its ledger_seq, or a tick once resolved), coloured by its one of
// two visible states: Open or Resolved. Beside the chips it reads its progress,
// "{n} of {m} resolved" (checkpointProgressText); no banner.
// Activating a chip scrolls to and rings that checkpoint's row in the feed. No
// checkpoint text and no controls live here. When the post has no checkpoints
// the strip renders nothing.

import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
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
import { IconCheck } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
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
export type ChipState = 'open' | 'resolved';
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

/** One chip per checkpoint, ledger_seq ascending. Each chip is a real button with
 *  a 44px minimum touch target (the visible circle is smaller) and an accessible
 *  label naming the checkpoint it jumps to; activating it scrolls to and rings
 *  that checkpoint's row in the feed. A resolved chip shows a tick glyph in place
 *  of its number. */
export function checkpointChips(rows: readonly CheckpointChipRow[]): ReactElement[] {
  return byLedgerSeq(rows).map((row) => {
    const state = chipState(row);
    const seq = row.ledger_seq ?? 0;
    return (
      <button
        key={row.id}
        type="button"
        aria-label={`Jump to checkpoint ${seq}`}
        onClick={() => flashNode(commentDomId(row.id))}
        // axis: none. Chips never translate, rotate or scale.
        className="flex h-11 min-h-[44px] w-11 min-w-[44px] shrink-0 items-center justify-center rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <span
          aria-hidden
          data-chip-tick={
            state === 'open' ? 'open' : row.accepted_at !== null ? 'filled' : 'hollow'
          }
          className={cn(
            'flex h-7 w-7 items-center justify-center rounded-full border font-mono text-xs font-semibold tabular-nums',
            chipCircleClass(state, row.accepted_at !== null),
          )}
        >
          {state === 'open' ? seq : <IconCheck size={14} />}
        </span>
      </button>
    );
  });
}

/** The strip's sticky surface: the same token as the comments card it sits in. */
export const STRIP_SURFACE_CLASS = 'bg-panel-2';

/** Overlay the comments list's live state onto the strip's own read. Pure. */
export function withLiveState(
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

export interface CheckpointStripProps {
  workspaceId: string;
  postId: string;
  /** True when the viewer's workspace role is 'client'. Kept for the page's
   *  call site; the strip reads the same for both sides now. */
  viewerIsClient: boolean;
  /** Bumped by the page (shared with Comments) to refetch. */
  refreshSignal: number;
  /** Lifted counts so the page renders its header chip without a second fetch. */
  onCounts?: (counts: CheckpointCounts) => void;
}

export function CheckpointStrip({
  workspaceId,
  postId,
  refreshSignal,
  onCounts,
}: CheckpointStripProps): ReactElement | null {
  const [rows, setRows] = useState<CheckpointChipRow[]>([]);
  const [loaded, setLoaded] = useState(false);

  // Switching posts drops the prior rows so nothing bleeds across.
  useEffect(() => {
    setRows([]);
    setLoaded(false);
  }, [postId]);

  // Self-fetch, mirroring the feed: one plain RLS-scoped select of this post's
  // checkpoint rows, narrowed to the columns the chips and counter need. One
  // query, never a query inside a loop. A failed read keeps whatever was shown.
  const load = useCallback(async (): Promise<void> => {
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
  }, [workspaceId, postId]);

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
  // Undo included) wins over this read, so a chip changes in the same paint as
  // the row and the header count. No refetch.
  const live = useContext(LiveCheckpointsContext);
  const shown = useMemo(() => withLiveState(rows, live), [rows, live]);

  // Lift the counts once a fetch has landed so the page chip / tab badge stay
  // derived from this one read.
  useEffect(() => {
    if (!loaded) return;
    onCounts?.(checkpointCounts(shown));
  }, [shown, loaded, onCounts]);

  if (shown.length === 0) return null;
  const counts = checkpointCounts(shown);

  // The sticky background is the comments card's own surface (bg-panel-2), so
  // the strip never reads as a different-coloured band while pinned.
  return (
    <div
      data-checkpoint-strip=""
      className={cn('sticky top-0 z-10 flex border-b border-border py-2', STRIP_SURFACE_CLASS)}
    >
      {/* axis: horizontal scroll only (overflow-x). Never overflow-y, never wrap:
          a twenty-point post stays one row and never grows vertically. */}
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {checkpointChips(shown)}
      </div>
      <span
        data-checkpoint-progress=""
        className="ml-2 shrink-0 self-center text-xs tabular-nums text-fg-3"
      >
        {checkpointProgressText(counts.resolved, counts.total)}
      </span>
    </div>
  );
}
