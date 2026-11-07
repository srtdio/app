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
import { daysFromToday, formatAgo, formatDue, formatOverdue } from '@/lib/time';
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

/** "Open" or "Closed": the one status word (anything not closed reads Open). */
export function briefStatusLabel(status: string): 'Open' | 'Closed' {
  return status === BRIEF_STATUS.closed ? 'Closed' : 'Open';
}

/**
 * The one status tag used on the list card (ListCard's tag slot), the detail
 * page and the chat brief card, so Open and Closed read the same everywhere:
 * the grey ui/Tag look (tagClass neutral), text only, carrying data-brief-status. Not
 * interactive, no motion.
 */
export function BriefStatusPill({ status }: { status: string }): ReactElement {
  const closed = status === BRIEF_STATUS.closed;
  return (
    <span
      data-brief-status={closed ? BRIEF_STATUS.closed : BRIEF_STATUS.open}
      className={cn(tagClass('neutral'), 'shrink-0 whitespace-nowrap')}
    >
      {briefStatusLabel(status)}
    </span>
  );
}

/**
 * The card's due words (formatDue): "Today", "Tomorrow", "Fri", "8 Oct"
 * ("4 Jan 2027" outside now's year), on the workspace zone (due dates are
 * workspace calendar days). Words only: never "Due".
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
  /** The clock the time reads against (the list's one useMinuteClock). Default: now. */
  now?: Date | undefined;
}

/** A brief's line 1 time: the text, and whether it is overdue (the bad token). */
export interface BriefCardTime {
  text: string;
  bad: boolean;
}

/**
 * A brief's line 1 time. With a due date: "Today" / "Fri" / "12 Dec"
 * (formatDue), or "2d late" in the bad tone once the day has passed
 * (formatOverdue); a closed brief is never late (it keeps its "12 Oct").
 * Without one: when it was raised, "3h" (formatAgo, on the device zone).
 * Due days read on the workspace zone. Pure.
 */
export function briefCardTime(
  brief: Pick<Brief, 'target_date' | 'created_at' | 'status'>,
  timeZone: string | null | undefined,
  now: Date = new Date(),
): BriefCardTime {
  if (brief.target_date === null) {
    return { text: formatAgo(brief.created_at, now), bad: false };
  }
  const days = daysFromToday(brief.target_date, timeZone, now);
  if (days !== undefined && days < 0 && brief.status !== BRIEF_STATUS.closed) {
    return { text: formatOverdue(brief.target_date, timeZone, now).text, bad: true };
  }
  return { text: briefDueLabel(brief.target_date, timeZone, now), bad: false };
}

/**
 * A brief on ui/ListCard: the first image attachment (else the brief icon) as
 * the picture; line 1 the title and the due / late time (briefCardTime);
 * line 2 the brief text as the one-line preview (stripFormat) and the grey
 * Open / Closed tag (a closed brief keeps the muted card). No select mode:
 * a long-press or right-click does nothing. No link preview on the card (the
 * brief screen lists the links). The card's one real link is laid over the
 * whole card (named by the title). Closing a brief lives in the detail
 * page's menu, never on the card.
 */
export function BriefCard({ brief, cache, presignEnabled, href, timeZone, now }: BriefCardProps) {
  const closed = isBriefClosed(brief);
  // growFromCard: the brief's page grows out of this card; Back grows it back.
  const cardRef = useGrowBackIntoCard<HTMLElement>(brief.id);
  const time = briefCardTime(brief, timeZone, now);

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
      time={time.text}
      timeBad={time.bad}
      timeHooks={brief.target_date !== null ? { 'data-brief-due': '' } : { 'data-brief-date': '' }}
      tag={briefStatusLabel(brief.status)}
      tagHooks={{ 'data-brief-status': closed ? BRIEF_STATUS.closed : BRIEF_STATUS.open }}
    />
  );
}
