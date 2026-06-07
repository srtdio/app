import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import type { Brief, ListBriefsFilters } from '@srtdio/briefs';

/** Open/closed are the only brief statuses; the literals are pinned to the
 * @srtdio/briefs filter type so a package rename surfaces here as a type error
 * rather than a silently stale string. */
export type BriefStatus = NonNullable<ListBriefsFilters['status']>;
export const BRIEF_STATUS: Record<BriefStatus, BriefStatus> = { open: 'open', closed: 'closed' };

export function isBriefClosed(brief: Brief): boolean {
  return brief.status === BRIEF_STATUS.closed;
}

/** Render an ISO date as date only (no time), matching the Briefs reference. */
function formatTargetDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

interface BriefCardProps {
  brief: Brief;
  /** Live linked-post count when the read path supplies one; omitted otherwise. */
  linkedCount?: number;
  /** True while this brief's close call is in flight. */
  closing: boolean;
  /** Inline error from a failed close of this brief, if any. */
  closeError: string | null;
  /** Confirmed request to close this open brief. */
  onConfirmClose: () => void;
  /** Open this brief's detail view; the whole card is the tap target. */
  onOpen: () => void;
}

/**
 * A brief card on the PR A primitives: title, truncated objective, a status
 * indicator, optional target date and linked-post count, a subtle Closed marker,
 * and an inline-confirmed Close action offered only while the brief is open.
 */
export function BriefCard({
  brief,
  linkedCount,
  closing,
  closeError,
  onConfirmClose,
  onOpen,
}: BriefCardProps) {
  const [confirming, setConfirming] = useState(false);
  const closed = isBriefClosed(brief);

  return (
    <div
      role="link"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
      className={`text-left cursor-pointer rounded-xl border border-border bg-panel p-4 flex flex-col gap-2.5 min-h-[44px] hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
        closed ? 'opacity-70' : ''
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="text-sm font-medium leading-snug line-clamp-2 flex-1">{brief.title}</div>
        <span className="flex items-center gap-1.5 shrink-0 text-xs text-fg-3">
          <span
            className={`h-2 w-2 rounded-full ${closed ? 'bg-fg-3' : 'bg-good'}`}
            aria-hidden="true"
          />
          {closed ? 'Closed' : 'Open'}
        </span>
      </div>

      <p className="text-sm text-fg-3 line-clamp-2">{brief.objective}</p>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-3">
        {brief.target_date !== null ? (
          <span className="tabular-nums">{formatTargetDate(brief.target_date)}</span>
        ) : null}
        {linkedCount !== undefined ? (
          <span className="tabular-nums">
            {linkedCount} linked {linkedCount === 1 ? 'post' : 'posts'}
          </span>
        ) : null}
      </div>

      {closeError !== null ? (
        <div role="alert" className="rounded-md border border-bad px-3 py-2 text-xs text-bad">
          {closeError}
        </div>
      ) : null}

      {!closed ? (
        <div
          className="flex items-center gap-2 pt-0.5"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          role="presentation"
        >
          {confirming ? (
            <>
              <span className="text-xs text-fg-3 mr-auto">Close this brief?</span>
              <Button size="lg" onClick={() => setConfirming(false)} disabled={closing}>
                Cancel
              </Button>
              <Button variant="primary" size="lg" onClick={onConfirmClose} disabled={closing}>
                {closing ? 'Closing' : 'Close'}
              </Button>
            </>
          ) : (
            <span className="ml-auto">
              <Button size="lg" onClick={() => setConfirming(true)}>
                Close
              </Button>
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}
