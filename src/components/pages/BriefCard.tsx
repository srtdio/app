import { rememberCard } from '@/lib/motion';
import { stripFormat } from '@srtdio/comments';
import { useGrowBackIntoCard } from '@/lib/motion/pages';
import { Link } from 'react-router-dom';
import type { ReactElement } from 'react';
import { ICON_SIZE, IconBriefs } from '@/components/ui/icons';
import { tagClass } from '@/components/ui/Tag';
import { cn } from '@/lib/cn';
import { LIST_CARD_COVER, ListCard } from '@/components/ui/ListCard';
import { Thumbnail } from '@/components/media';
import { formatDue, formatWhen } from '@/lib/time';
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
 * A brief's first usable reference link, or null for none (an image brief: the
 * picture already carries the visual). The list card (ui/ListCard) shows no
 * link of its own; the detail page lists them. Pure, so the precedence is
 * unit-tested.
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
  /** False when presigning is unconfigured: the picture shows the brief icon. */
  presignEnabled: boolean;
  /** Where the card link goes (the pretty /b/KEY-N path, or /briefs/:id). */
  href: string;
  /** The workspace zone the dates read on. Absent: the device zone. */
  timeZone?: string | null | undefined;
  /** The clock the date reads against. Default: now. */
  now?: Date;
}

/**
 * A brief's line 3 date: "Due 8 Oct" when it has a due date, else the day it
 * was raised (formatWhen: "10:27 AM", "Yesterday", "Mon", "19 Oct"). Pure.
 */
export function briefCardDate(
  brief: Pick<Brief, 'target_date' | 'created_at'>,
  timeZone: string | null | undefined,
  now: Date = new Date(),
): string {
  if (brief.target_date !== null) return briefDueLabel(brief.target_date, timeZone, now);
  return formatWhen(brief.created_at, now, timeZone ?? undefined);
}

/**
 * A brief on ui/ListCard: the first image attachment (else the brief icon) as
 * the picture, the title, the objective as the 2-line preview, then the date
 * and the Open / Closed tag. The card's one real link is laid over the whole
 * card (named by the title). Closing a brief lives in the detail page's menu,
 * never on the card.
 */
export function BriefCard({ brief, cache, presignEnabled, href, timeZone, now }: BriefCardProps) {
  const closed = isBriefClosed(brief);
  // growFromCard: the brief's page grows out of this card; Back grows it back.
  const cardRef = useGrowBackIntoCard<HTMLElement>(brief.id);
  const date = briefCardDate(brief, timeZone, now);

  return (
    <ListCard
      rootRef={cardRef}
      surface={{ 'data-brief-card': '' }}
      // A closed brief is the muted card with its Closed tag, never dimmed.
      muted={closed}
      cover={
        <Link
          to={href}
          aria-label={brief.title}
          onClick={() => rememberCard(brief.id, cardRef.current)}
          data-brief-card-link=""
          className={LIST_CARD_COVER}
        />
      }
      picture={
        brief.thumbnailAssetVersionId !== null
          ? {
              kind: 'image',
              node: (
                <Thumbnail
                  assetVersionId={brief.thumbnailAssetVersionId}
                  cache={cache}
                  presignEnabled={presignEnabled}
                  aspect="square"
                  fallback={{ kind: 'glyph' }}
                  fallbackTile={
                    <span className="flex h-full w-full items-center justify-center bg-panel-2 text-fg-2">
                      <IconBriefs size={ICON_SIZE.picture} />
                    </span>
                  }
                  alt={brief.title}
                />
              ),
            }
          : { kind: 'icon', icon: IconBriefs }
      }
      pictureHooks={{
        'data-brief-tile': brief.thumbnailAssetVersionId !== null ? 'image' : 'icon',
      }}
      title={<span aria-hidden="true">{brief.title}</span>}
      preview={stripFormat(brief.objective)}
      time={date}
      timeHooks={brief.target_date !== null ? { 'data-brief-due': '' } : { 'data-brief-date': '' }}
      tag={closed ? 'Closed' : 'Open'}
      tagHooks={{ 'data-brief-status': closed ? BRIEF_STATUS.closed : BRIEF_STATUS.open }}
    />
  );
}
