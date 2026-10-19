import { Link } from 'react-router-dom';
import { IconBriefs } from '@/components/ui/icons';
import { LinkPreviewCard } from '@/components/ui/LinkPreviewCard';
import { Thumbnail } from '@/components/media';
import { formatCivilDay } from '@/lib/brief-groups';
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
 * The one external link a card may show, or null for none. An image brief keeps the
 * card exactly as it was: the thumbnail already carries the visual, so no button is
 * added. Only a brief with no image attachment falls through to its first reference
 * link, and never to more than one. Pure, so the precedence is unit-tested.
 */
export function briefCardLink(brief: BriefWithThumbnail): ExternalLink | null {
  if (brief.thumbnailAssetVersionId !== null) return null;
  return toExternalLinks(brief.reference_links)[0] ?? null;
}

/** The card's due line: "Due Oct 8", read off the date-only string itself. */
export function briefDueLabel(targetDate: string): string {
  return `Due ${formatCivilDay(targetDate)}`;
}

interface BriefCardProps {
  brief: BriefWithThumbnail;
  /** The page-owned presign cache, shared across every card; the tile never makes its own. */
  cache: PresignCache;
  /** False when presigning is unconfigured: the leading tile shows a fallback. */
  presignEnabled: boolean;
  /** Where the title link goes (the pretty /b/KEY-N path, or /briefs/:id). */
  href: string;
}

/**
 * A brief card: a leading square tile (the first image attachment, else a brief
 * icon), then title, truncated objective, status, and the due date. The title
 * is the one real link; its ::after overlay stretches over the card so the whole
 * card still opens the brief, and nothing interactive is nested inside a link.
 * The optional reference link sits above that overlay. Closing a brief lives in
 * the detail page's menu, never on the card.
 */
export function BriefCard({ brief, cache, presignEnabled, href }: BriefCardProps) {
  const closed = isBriefClosed(brief);
  const link = briefCardLink(brief);

  return (
    <div
      data-brief-card=""
      className={`relative rounded-xl border border-border bg-panel p-4 flex gap-3 min-w-0 overflow-hidden min-h-[44px] transition-colors duration-fast hover:bg-panel-2 focus-within:ring-2 focus-within:ring-accent ${
        closed ? 'opacity-70' : ''
      }`}
    >
      {/* Leading square visual. The wrapper supplies the radius + overflow-hidden so
          the shared tile (which adds none of its own) clips edge-to-edge. 64px keeps
          it comfortably above the 44px touch floor without crowding a ~360px card. */}
      <div className="w-16 shrink-0 overflow-hidden rounded-lg">
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
            <IconBriefs size={22} />
          </div>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <div className="flex min-w-0 items-start gap-3">
          <Link
            to={href}
            className="flex-1 text-sm font-medium leading-snug line-clamp-2 text-fg focus:outline-none after:absolute after:inset-0 after:content-['']"
          >
            {brief.title}
          </Link>
          <span className="flex items-center gap-1.5 shrink-0 text-xs text-fg-3">
            <span
              className={`h-2 w-2 rounded-full ${closed ? 'bg-fg-3' : 'bg-good'}`}
              aria-hidden="true"
            />
            {closed ? 'Closed' : 'Open'}
          </span>
        </div>

        <p className="text-sm text-fg-3 line-clamp-2">{brief.objective}</p>

        {/* Above the title's stretched overlay, so a tap follows this link only. */}
        {link !== null ? (
          <div className="relative z-10 flex min-w-0">
            {/* Compact: the list card has no room for a picture. */}
            <LinkPreviewCard url={link.href} size="compact" className="w-full max-w-[320px]" />
          </div>
        ) : null}

        {brief.target_date !== null ? (
          <div className="text-xs text-fg-3">
            <span className="tabular-nums">{briefDueLabel(brief.target_date)}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
