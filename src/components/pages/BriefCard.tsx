import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { LinkButton } from '@/components/ui/LinkButton';
import { Thumbnail, type ThumbnailFallback } from '@/components/media';
import { toExternalLinks, type ExternalLink } from '@/lib/links';
import type { PresignCache } from '@/lib/asset-presign';
import type { Brief, BriefWithThumbnail, ListBriefsFilters } from '@srtdio/briefs';

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

/** The objective (or title) text used for the text-fallback caption, trimmed. */
function objectiveCaption(brief: Brief): string | null {
  const objective = brief.objective.trim();
  if (objective !== '') return objective;
  const title = brief.title.trim();
  if (title !== '') return title;
  return null;
}

/**
 * The non-image tile for a brief, mirroring PostCard.postFallback. Used only when the
 * brief has no thumbnail image (or presign is disabled/fails). The tile no longer
 * carries the link case: a reference link is now a real, tappable LinkButton in the
 * card body rather than a dead domain label painted inside the thumbnail. Selection
 * order: objective/title text -> a caption snippet; else a plain glyph. The image
 * path itself is owned by Thumbnail (it shows this fallback whenever
 * thumbnailAssetVersionId is null).
 */
function briefFallback(brief: BriefWithThumbnail): ThumbnailFallback {
  const caption = objectiveCaption(brief);
  if (caption !== null) return { kind: 'text', caption };
  return { kind: 'glyph' };
}

/**
 * The one external link a card may show, or null for none. An image brief keeps the
 * card exactly as it was: the thumbnail already carries the visual, so no button is
 * added. Only a brief with no image attachment falls through to its first reference
 * link, and never to more than one. Pure, so the precedence is unit-tested.
 */
export function briefCardLink(brief: BriefWithThumbnail): ExternalLink | null {
  if (brief.thumbnailAssetVersionId !== null) return null;
  return toExternalLinks(brief.reference_links)[0] ?? null;
}

interface BriefCardProps {
  brief: BriefWithThumbnail;
  /** The page-owned presign cache, shared across every card; the tile never makes its own. */
  cache: PresignCache;
  /** False when presigning is unconfigured: the leading tile shows a fallback. */
  presignEnabled: boolean;
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
 * A brief card on the PR A primitives: a leading square thumbnail (the shared
 * Thumbnail tile, same one Pipeline and Assets use), then title, truncated
 * objective, a status indicator, optional target date and linked-post count, a
 * subtle Closed marker, and an inline-confirmed Close action offered only while the
 * brief is open. The thumbnail is additive: existing fields are unchanged.
 */
export function BriefCard({
  brief,
  cache,
  presignEnabled,
  linkedCount,
  closing,
  closeError,
  onConfirmClose,
  onOpen,
}: BriefCardProps) {
  const [confirming, setConfirming] = useState(false);
  const closed = isBriefClosed(brief);
  const link = briefCardLink(brief);

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
      className={`text-left cursor-pointer rounded-xl border border-border bg-panel p-4 flex gap-3 min-w-0 overflow-hidden min-h-[44px] hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
        closed ? 'opacity-70' : ''
      }`}
    >
      {/* Leading square visual. The wrapper supplies the radius + overflow-hidden so
          the shared tile (which adds none of its own) clips edge-to-edge. 64px keeps
          it comfortably above the 44px touch floor without crowding a ~360px card. */}
      <div className="w-16 shrink-0 overflow-hidden rounded-lg">
        <Thumbnail
          assetVersionId={brief.thumbnailAssetVersionId}
          cache={cache}
          presignEnabled={presignEnabled}
          aspect="square"
          fallback={briefFallback(brief)}
          alt={brief.title}
        />
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <div className="flex min-w-0 items-start gap-3">
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

        {/* The card itself is the tap target for opening the brief, so the link
            stops propagation exactly as the Close action below does: tapping the
            button follows the link instead of also opening the detail view. */}
        {link !== null ? (
          <div
            className="flex min-w-0"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            role="presentation"
          >
            <LinkButton url={link.href} />
          </div>
        ) : null}

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
            className="flex min-w-0 flex-wrap items-center gap-2 pt-0.5"
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
    </div>
  );
}
