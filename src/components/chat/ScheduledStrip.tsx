// The scheduled strip above the composer: shown only while the viewer has 1+
// scheduled messages in this chat. One 48px button on accent-soft with a top
// border: the calendar-clock in accent, "N scheduled message(s)", the next
// send time in mono, a chevron. A strip already there when the chat opens
// paints with the thread's first frame (no motion); one that appears because
// a message was just scheduled here slides up above the composer (stripIn,
// Y only). It opens "Scheduled in this chat". Tokens only.
//
// When the next message carries photos or files, their small thumbnails sit
// before the time (ScheduledAttachments, shared with the cards).
//
// It listens for SCHEDULED_CHANGED_EVENT naming its chat and asks for a
// refetch, so a change from any surface (the bell included) shows at once.
// It stays mounted (rendering nothing) while the chat has no scheduled rows,
// so the first one still lands.
//
// Also the composer's schedule-mode strip ("Sends tomorrow 9:00 AM" with a
// 44px x), which slides up on translateY only (stripIn above the composer).

import { useEffect, useLayoutEffect, useRef } from 'react';
import { stripIn, useMoveOnMount } from '@/lib/motion';
import type { ReactElement } from 'react';
import {
  ICON_SIZE,
  IconCalendarClock,
  IconChevronRight,
  IconFile,
  IconImage,
  IconX,
} from '@/components/ui/icons';
import { IconButton } from '@/components/ui/IconButton';
import { PressableRow } from '@/components/ui/PressableRow';
import { cn } from '@/lib/cn';
import { NO_TOUCH_SELECT } from '@/components/chat/chat-type';
import { useAttachmentUrl } from '@/components/chat/MessageAttachments';
import { PRESIGN_ENABLED, sharedCardPresignCache } from '@/components/chat/PostCard';
import { parseAttachmentMeta, splitAlbum, type MessageAttachment } from '@/lib/chat/attachments';
import {
  formatSendLabel,
  onScheduledChanged,
  scheduledCountLabel,
  type ScheduledRow,
} from '@/lib/chat/scheduled';

/** A scheduled row's attachments in send order, read from its stored meta. Pure. */
function scheduledRowAttachments(
  row: Pick<ScheduledRow, 'attachment_meta' | 'attachment_asset_ids'>,
): MessageAttachment[] {
  return parseAttachmentMeta(row.attachment_meta, row.attachment_asset_ids ?? []);
}

/** At most this many photo thumbnails; the last carries "+N" for the rest. */
const MAX_THUMBS = 4;

/** The photo thumbnails to show: up to four, the fourth with "+N" (N = count - 4). Pure. */
export function thumbTiles(
  images: readonly MessageAttachment[],
): Array<{ attachment: MessageAttachment; more: number }> {
  return images.slice(0, MAX_THUMBS).map((attachment, index) => ({
    attachment,
    more: index === MAX_THUMBS - 1 ? images.length - MAX_THUMBS : 0,
  }));
}

/** One small photo thumbnail through the shared presign cache (asset read URL). */
function Thumb(props: {
  attachment: MessageAttachment;
  more: number;
  size: 'strip' | 'card';
}): ReactElement {
  const { url, failed } = useAttachmentUrl(
    props.attachment.assetId,
    sharedCardPresignCache(),
    PRESIGN_ENABLED,
  );
  return (
    <span
      data-scheduled-thumb=""
      className={cn(
        'relative flex shrink-0 items-center justify-center overflow-hidden bg-panel-3 text-fg-3',
        props.size === 'strip' ? 'h-7 w-7 rounded-lg' : 'h-12 w-12 rounded-lg',
      )}
    >
      {url !== null && !failed ? (
        <img
          src={url}
          alt={props.attachment.name}
          draggable={false}
          className="h-full w-full object-cover"
        />
      ) : (
        <IconImage size={props.size === 'strip' ? ICON_SIZE.inline : ICON_SIZE.nav} />
      )}
      {props.more > 0 ? (
        <span
          data-thumb-more=""
          className="absolute inset-0 flex items-center justify-center bg-overlay text-sm font-semibold text-overlay-fg"
        >
          +{props.more}
        </span>
      ) : null}
    </span>
  );
}

/**
 * A scheduled message's attachments: up to four photo thumbnails ("+N" on the
 * fourth), then each file as its icon and name. Nothing for a text-only row.
 * Thumbnails presign through the shared cache, which dedupes and caps
 * concurrency, so a list of cards reads each version once.
 */
export function ScheduledAttachments(props: {
  row: Pick<ScheduledRow, 'attachment_meta' | 'attachment_asset_ids'>;
  size: 'strip' | 'card';
}): ReactElement | null {
  const attachments = scheduledRowAttachments(props.row);
  if (attachments.length === 0) return null;
  const { images, others } = splitAlbum(attachments);
  const strip = props.size === 'strip';
  return (
    <span
      data-scheduled-attachments={attachments.length}
      className={cn('flex min-w-0', strip ? 'items-center gap-1' : 'flex-col items-end gap-1.5')}
    >
      {images.length > 0 ? (
        <span className="flex shrink-0 items-center gap-1">
          {thumbTiles(images).map((tile, index) => (
            <Thumb
              key={`${tile.attachment.assetId}-${index}`}
              attachment={tile.attachment}
              more={tile.more}
              size={props.size}
            />
          ))}
        </span>
      ) : null}
      {(strip ? others.slice(0, 1) : others).map((file, index) => (
        <span
          key={`${file.assetId}-${index}`}
          data-scheduled-file=""
          className={cn(
            'flex min-w-0 items-center gap-1.5 text-fg-2',
            !strip && 'max-w-[85%] rounded-lg border bg-panel px-2 py-1.5 lit-card',
          )}
        >
          <IconFile size={ICON_SIZE.inline} className="shrink-0 text-fg-3" />
          <span className="truncate text-sm">{file.name.trim() !== '' ? file.name : 'File'}</span>
        </span>
      ))}
    </span>
  );
}

/** The scheduled strip slides its own 48px height above the composer when created. */
const SCHEDULED_STRIP_SLIDE_PX = 48;
/** The schedule-mode strip slides its own 44px height. */
const SCHEDULE_MODE_SLIDE_PX = 44;

export function ScheduledStrip(props: {
  rows: readonly ScheduledRow[];
  onOpen: () => void;
  /** The open chat: a SCHEDULED_CHANGED_EVENT naming it calls onChanged. */
  channelId?: string;
  /** Refetch this chat's rows. */
  onChanged?: () => void;
  /** Override for tests. */
  now?: Date;
}): ReactElement | null {
  const onChangedRef = useRef(props.onChanged);
  onChangedRef.current = props.onChanged;
  const channelId = props.channelId;
  // Armed by a schedule change in this chat: the strip that then appears was
  // just created, so it slides in. Never on a chat open (nothing armed).
  const created = useRef(false);
  useEffect(() => {
    created.current = false;
    if (channelId === undefined) return;
    return onScheduledChanged(channelId, () => {
      created.current = true;
      onChangedRef.current?.();
    });
  }, [channelId]);
  const stripRef = useRef<HTMLButtonElement>(null);
  const next = props.rows[0];
  const shown = next !== undefined;
  const wasShown = useRef(shown);
  useLayoutEffect(() => {
    if (shown && !wasShown.current && created.current) {
      stripIn(stripRef.current, 'above-composer', SCHEDULED_STRIP_SLIDE_PX);
    }
    if (shown) created.current = false;
    wasShown.current = shown;
  }, [shown]);
  if (next === undefined) return null;
  return (
    <PressableRow
      buttonRef={stripRef}
      type="button"
      flat
      data-scheduled-strip=""
      onClick={props.onOpen}
      onContextMenu={(event) => event.preventDefault()}
      className={cn(
        'flex h-12 shrink-0 items-center gap-3 border-t bg-accent-soft px-4 lit-dock hover:bg-accent-soft focus-visible:ring-inset',
        NO_TOUCH_SELECT,
      )}
    >
      <IconCalendarClock size={ICON_SIZE.control} className="shrink-0 text-accent" />
      <span className="truncate text-base font-semibold text-fg">
        {scheduledCountLabel(props.rows.length)}
      </span>
      <ScheduledAttachments row={next} size="strip" />
      <span className="ml-auto truncate font-mono text-sm tabular-nums text-fg-2">
        {formatSendLabel(new Date(next.send_at), props.now ?? new Date())}
      </span>
      <IconChevronRight size={ICON_SIZE.inline} className="shrink-0 text-fg-2" />
    </PressableRow>
  );
}

/** The composer in schedule mode: "Sends <label>" and an x that leaves it. */
export function ScheduleModeStrip(props: { label: string; onStop: () => void }): ReactElement {
  // Painted at rest; it slides up its own 44px height on the first frame.
  const ref = useRef<HTMLDivElement>(null);
  useMoveOnMount(ref, (el) => stripIn(el, 'above-composer', SCHEDULE_MODE_SLIDE_PX));
  return (
    <div className="overflow-hidden rounded-lg">
      <div
        ref={ref}
        data-schedule-mode=""
        className={cn(
          'flex min-w-0 items-center gap-2 bg-accent-soft pl-3 lit-tint',
          NO_TOUCH_SELECT,
        )}
      >
        <IconCalendarClock size={ICON_SIZE.nav} className="shrink-0 text-accent" />
        <span className="flex-1 truncate text-base font-medium text-fg">Sends {props.label}</span>
        <IconButton label="Stop scheduling" className="shrink-0" onClick={props.onStop}>
          <IconX size={ICON_SIZE.inline} />
        </IconButton>
      </div>
    </div>
  );
}
