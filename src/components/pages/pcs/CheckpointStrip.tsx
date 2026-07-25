// The checkpoint strip on PCS: a sticky, single-row index of the post's
// checkpoint comments. The comment feed now owns every checkpoint's body, state
// and controls; the strip is only a jump index into it. It shows one chip per
// checkpoint (its ledger_seq, or a tick once resolved), coloured by state, a
// settled-of-total counter, and a client-facing banner when points await the
// client. Activating a chip scrolls to and rings that checkpoint's row in the
// feed. No checkpoint text and no controls live here. When the post has no
// checkpoints the strip renders nothing.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { commentDomId } from '@/components/comments/Comments';
import { flashNode } from '@/components/comments/flash-node';
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

/** Settled counts every checkpoint whose resolved_at is not null, against the
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
 * The chip's state, derived from columns and never stored: 'confirmed' once
 * accepted (accepted_at set), 'awaiting' the client once resolved but not yet
 * confirmed, 'open' while unresolved. Confirmed requires resolved, so an agency
 * reopen (resolved_at back to null) drops a chip straight to 'open'.
 */
export type ChipState = 'open' | 'awaiting' | 'confirmed';
export function chipState(row: Pick<CheckpointChipRow, 'resolved_at' | 'accepted_at'>): ChipState {
  if (row.resolved_at === null) return 'open';
  return row.accepted_at !== null ? 'confirmed' : 'awaiting';
}

/** The visible circle's treatment per state, from design tokens only so light and
 *  dark parity is automatic: confirmed fills with the success token; awaiting the
 *  client uses the soft success background for a hollow green tick; open uses the
 *  muted panel treatment. */
export function chipCircleClass(state: ChipState): string {
  switch (state) {
    case 'confirmed':
      return 'border-good bg-good text-white';
    case 'awaiting':
      return 'border-good bg-good-soft text-good';
    case 'open':
      return 'border-border bg-panel-2 text-fg-3';
  }
}

/** How many checkpoints await the client (resolved, unconfirmed). Drives the
 *  client-facing banner. */
export function awaitingCount(rows: readonly CheckpointChipRow[]): number {
  return rows.filter((row) => chipState(row) === 'awaiting').length;
}

/** A copy sorted by ledger_seq ascending. The query already orders; this keeps
 *  the render order-stable regardless of read order and self-contained for tests. */
function byLedgerSeq(rows: readonly CheckpointChipRow[]): CheckpointChipRow[] {
  return [...rows].sort((a, b) => (a.ledger_seq ?? 0) - (b.ledger_seq ?? 0));
}

/** One chip per checkpoint, ledger_seq ascending. Each chip is a real button with
 *  a 44px minimum touch target (the visible circle is smaller) and an accessible
 *  label naming the checkpoint it jumps to; activating it scrolls to and rings
 *  that checkpoint's row in the feed. A resolved chip (awaiting or confirmed, the
 *  ones the counter counts) shows a tick glyph in place of its number. */
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
        className="flex h-11 min-h-[44px] w-11 min-w-[44px] shrink-0 items-center justify-center rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <span
          aria-hidden
          className={cn(
            'flex h-7 w-7 items-center justify-center rounded-full border font-mono text-xs font-semibold tabular-nums',
            chipCircleClass(state),
          )}
        >
          {state === 'open' ? seq : <IconCheck size={14} />}
        </span>
      </button>
    );
  });
}

export interface CheckpointStripProps {
  workspaceId: string;
  postId: string;
  /** True when the viewer's workspace role is 'client'; gates the banner. */
  viewerIsClient: boolean;
  /** Bumped by the page (shared with Comments) to refetch. */
  refreshSignal: number;
  /** Lifted counts so the page renders its header chip without a second fetch. */
  onCounts?: (counts: CheckpointCounts) => void;
}

export function CheckpointStrip({
  workspaceId,
  postId,
  viewerIsClient,
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

  // Lift the counts once a fetch has landed so the page chip / tab badge stay
  // derived from this one read.
  useEffect(() => {
    if (!loaded) return;
    onCounts?.(checkpointCounts(rows));
  }, [rows, loaded, onCounts]);

  if (rows.length === 0) return null;

  const { resolved, total } = checkpointCounts(rows);
  const awaiting = awaitingCount(rows);

  return (
    <div className="sticky top-0 z-10 flex flex-col gap-1.5 border-b border-border bg-bg py-2">
      <div className="flex items-center gap-2">
        {/* axis: horizontal scroll only (overflow-x). Never overflow-y, never wrap:
            a twenty-point post stays one row and never grows vertically. */}
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {checkpointChips(rows)}
        </div>
        <span
          aria-label={`${resolved} of ${total} checkpoints settled`}
          className="shrink-0 pr-1 font-mono text-xs font-medium tabular-nums text-fg-2"
        >
          {resolved}/{total}
        </span>
      </div>
      {viewerIsClient && awaiting > 0 ? (
        <p className="px-1 text-xs text-accent">
          {awaiting} {awaiting === 1 ? 'point' : 'points'} ready for your check.
        </p>
      ) : null}
    </div>
  );
}
