import { Link } from 'react-router-dom';
import type { ReactElement } from 'react';
import { ICON_SIZE, IconBriefs, IconLock } from '@/components/ui/icons';
import { LinkPreviewCard } from '@/components/ui/LinkPreviewCard';
import { Thumbnail } from '@/components/media';
import { formatDue } from '@/lib/time';
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

/**
 * The one status pill used on the list card, the detail page and the chat brief
 * card, so Open and Closed read the same everywhere. Open: accent-soft fill, an
 * accent dot and "Open". Closed: panel-3 fill, a lock and "Closed". Token
 * classes only, so light and dark follow the theme. Not interactive, no motion.
 * Anything that is not "closed" reads as Open (the only two statuses).
 */
export function BriefStatusPill({ status }: { status: string }): ReactElement {
  const closed = status === BRIEF_STATUS.closed;
  return (
    <span
      data-brief-status={closed ? BRIEF_STATUS.closed : BRIEF_STATUS.open}
      className={`inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-sm font-medium ${
        closed ? 'bg-panel-3 text-fg-2' : 'bg-accent-soft text-accent'
      }`}
    >
      {closed ? (
        <span aria-hidden="true">
          <IconLock size={ICON_SIZE.inline} />
        </span>
      ) : (
        <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />
      )}
      {closed ? 'Closed' : 'Open'}
    </span>
  );
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

/**
 * The card's due line: "Due 8 Oct" ("Due 4 Jan 2027" outside now's year), read
 * off the date-only string itself so no zone can shift the day; the workspace
 * zone (due dates are workspace calendar days) only decides now's year.
 */
export function briefDueLabel(
  targetDate: string,
  workspaceZone: string | null | undefined,
  now: Date = new Date(),
): string {
  return formatDue(targetDate, workspaceZone, now);
}

interface BriefCardProps {
  brief: BriefWithThumbnail;
  /** The page-owned presign cache, shared across every card; the tile never makes its own. */
  cache: PresignCache;
  /** False when presigning is unconfigured: the leading tile shows a fallback. */
  presignEnabled: boolean;
  /** Where the title link goes (the pretty /b/KEY-N path, or /briefs/:id). */
  href: string;
  /** The workspace zone the due date reads on. Absent: the device zone. */
  timeZone?: string | null | undefined;
}

/**
 * A brief card: a leading square tile (the first image attachment, else a brief
 * icon), then title, truncated objective, status, and the due date. The card's
 * one real link is laid over the whole card (inset-0, named by the title), so
 * the link itself is the full card tap target, and nothing interactive is nested
 * inside a link. The optional reference link sits above it. Closing a brief
 * lives in the detail page's menu, never on the card.
 */
export function BriefCard({ brief, cache, presignEnabled, href, timeZone }: BriefCardProps) {
  const closed = isBriefClosed(brief);
  const link = briefCardLink(brief);

  return (
    <div
      data-brief-card=""
      className={`relative rounded-xl border border-border bg-panel p-4 flex gap-3 min-w-0 overflow-hidden min-h-[44px] transition-colors duration-fast hover:bg-panel-2 focus-within:ring-2 focus-within:ring-accent ${
        closed ? 'opacity-70' : ''
      }`}
    >
      <Link
        to={href}
        aria-label={brief.title}
        data-brief-card-link=""
        className="absolute inset-0 rounded-xl focus:outline-none"
      />

      {/* Leading square visual. The wrapper supplies the radius + overflow-hidden so
          the shared tile (which adds none of its own) clips edge-to-edge. 64px keeps
          it comfortably above the 44px touch floor without crowding a ~360px card. */}
      <div className="pointer-events-none w-16 shrink-0 overflow-hidden rounded-lg">
        {brief.thumbnailAssetVersionId !== null ? (
          <Thumbnail
            assetVersionId={brief.thumbnailAssetVersionId}
            cache={cache}
            presignEnabled={presignEnabled}
            aspect="square"
            fallback={{ kind: 'glyph' }}
            alt={brief.title}
          />
        ) : (
          <div
            data-brief-tile="icon"
            className="flex aspect-square w-full items-center justify-center bg-panel-2 text-fg-3"
          >
            <IconBriefs size={ICON_SIZE.tray} />
          </div>
        )}
      </div>

      <div className="pointer-events-none flex min-w-0 flex-1 flex-col gap-2.5">
        <div className="flex min-w-0 items-start gap-3">
          <span
            aria-hidden="true"
            className="min-w-0 flex-1 break-words text-base font-medium leading-snug line-clamp-2 text-fg"
          >
            {brief.title}
          </span>
          <BriefStatusPill status={brief.status} />
        </div>

        <p className="min-w-0 break-words text-base text-fg-2 line-clamp-2">{brief.objective}</p>

        {/* Above the card link, so a tap follows this link only. */}
        {link !== null ? (
          <div className="pointer-events-auto relative z-10 flex min-w-0">
            {/* Compact: the list card has no room for a picture. */}
            <LinkPreviewCard url={link.href} size="compact" className="w-full max-w-[320px]" />
          </div>
        ) : null}

        {brief.target_date !== null ? (
          <div className="text-sm text-fg-3">
            <span className="tabular-nums">{briefDueLabel(brief.target_date, timeZone)}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
