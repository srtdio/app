import { rememberCard } from '@/lib/motion';
import { stripFormat } from '@srtdio/comments';
import { useGrowBackIntoCard } from '@/lib/motion/pages';
import { Link } from 'react-router-dom';
import type { ReactElement } from 'react';
import { ICON_SIZE, IconBriefs } from '@/components/ui/icons';
import { tagClass } from '@/components/ui/Tag';
import { cn } from '@/lib/cn';
import { CARD_COVER, Card } from '@/components/ui/Card';
import { LinkPreviewCard } from '@/components/ui/LinkPreviewCard';
import { Thumbnail } from '@/components/media';
import { formatDue } from '@/lib/time';
import { toExternalLinks, type ExternalLink } from '@/lib/links';
import type { PresignCache } from '@/lib/asset-presign';
import type { Brief, BriefWithThumbnail, ListBriefsFilters } from '@srtdio/briefs';

/** Open/closed are the only brief statuses; the literals are pinned to the
 * @srtdio/briefs filter type so a package rename surfaces here as a type error
 * rather than a silently stale string. */
type BriefStatus = NonNullable<ListBriefsFilters['status']>;
export const BRIEF_STATUS: Record<BriefStatus, BriefStatus> = { open: 'open', closed: 'closed' };

export function isBriefClosed(brief: Brief): boolean {
  return brief.status === BRIEF_STATUS.closed;
}

/**
 * The one status tag used on the list card, the detail page and the chat brief
 * card, so Open and Closed read the same everywhere. It is a ui/Tag (built from
 * tagClass so it can carry data-brief-status): Open is the accent tone, Closed
 * the neutral tone, text only. Not interactive, no motion. Anything that is not
 * "closed" reads as Open (the only two statuses).
 */
export function BriefStatusPill({ status }: { status: string }): ReactElement {
  const closed = status === BRIEF_STATUS.closed;
  return (
    <span
      data-brief-status={closed ? BRIEF_STATUS.closed : BRIEF_STATUS.open}
      className={cn(tagClass(closed ? 'neutral' : 'accent'), 'lit-pill shrink-0 whitespace-nowrap')}
    >
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
 * A brief card on ui/Card: the header holds a leading square tile (the first
 * image attachment, else a brief icon) and the title; the body the truncated
 * objective and the optional reference link; the footer the status tag and the
 * due date. The card's one real link is the Card cover (laid over the whole
 * card, named by the title), so nothing interactive is nested inside a link.
 * The optional reference link sits above it. Closing a brief lives in the
 * detail page's menu, never on the card.
 */
export function BriefCard({ brief, cache, presignEnabled, href, timeZone }: BriefCardProps) {
  const closed = isBriefClosed(brief);
  const link = briefCardLink(brief);
  // growFromCard: the brief's page grows out of this card; Back grows it back.
  const cardRef = useGrowBackIntoCard<HTMLElement>(brief.id);

  return (
    <Card
      rootRef={cardRef}
      surface={{ 'data-brief-card': '' }}
      // A closed brief is the muted card with an fg-2 title and its status tag, never dimmed.
      muted={closed}
      cover={
        <Link
          to={href}
          aria-label={brief.title}
          onClick={() => rememberCard(brief.id, cardRef.current)}
          data-brief-card-link=""
          className={CARD_COVER}
        />
      }
      leading={
        // The leading square visual (32, the header's leading size).
        <span className="block w-8 overflow-hidden rounded-lg">
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
            <span
              data-brief-tile="icon"
              className="flex aspect-square w-full items-center justify-center bg-panel-2 text-fg-3 lit-media"
            >
              <IconBriefs size={ICON_SIZE.control} />
            </span>
          )}
        </span>
      }
      title={
        <span aria-hidden="true" className={closed ? 'text-fg-2' : 'text-fg'}>
          {brief.title}
        </span>
      }
      badge={<BriefStatusPill status={brief.status} />}
      {...(brief.target_date !== null
        ? {
            footerTrailing: (
              <span data-brief-due="">{briefDueLabel(brief.target_date, timeZone)}</span>
            ),
          }
        : {})}
    >
      <p className="min-w-0 break-words text-base text-fg-2 line-clamp-2">
        {stripFormat(brief.objective)}
      </p>

      {/* Above the card link, so a tap follows this link only. */}
      {link !== null ? (
        <div className="pointer-events-auto relative z-10 flex min-w-0">
          {/* Compact: the list card has no room for a picture. */}
          <LinkPreviewCard url={link.href} size="compact" className="w-full max-w-xs" />
        </div>
      ) : null}
    </Card>
  );
}
