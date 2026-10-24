// The scheduled strip above the composer: shown only while the viewer has 1+
// scheduled messages in this chat. One 48px button on accent-soft with a top
// border: the calendar-clock in accent, "N scheduled message(s)", the next
// send time in mono, a chevron. It paints with the thread's first frame (no
// animation) and opens "Scheduled in this chat". Tokens only.
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
// 44px x), which slides on translateY only.

import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import {
  IconCalendarClock,
  IconChevronRight,
  IconFile,
  IconImage,
  IconX,
} from '@/components/ui/icons';
import { IconButton } from '@/components/ui/IconButton';
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
export function scheduledRowAttachments(
  row: Pick<ScheduledRow, 'attachment_meta' | 'attachment_asset_ids'>,
): MessageAttachment[] {
  return parseAttachmentMeta(row.attachment_meta, row.attachment_asset_ids ?? []);
}

/** At most this many photo thumbnails; the last carries "+N" for the rest. */
export const MAX_THUMBS = 4;

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
        props.size === 'strip' ? 'h-7 w-7 rounded-[5px]' : 'h-12 w-12 rounded-md',
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
        <IconImage size={props.size === 'strip' ? 14 : 18} />
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
            !strip && 'max-w-[85%] rounded-md border border-border bg-panel px-2 py-1.5',
          )}
        >
          <IconFile size={strip ? 14 : 16} className="shrink-0 text-fg-3" />
          <span className="truncate text-sm">{file.name.trim() !== '' ? file.name : 'File'}</span>
        </span>
      ))}
    </span>
  );
}

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
  useEffect(() => {
    if (channelId === undefined) return;
    return onScheduledChanged(channelId, () => onChangedRef.current?.());
  }, [channelId]);
  const next = props.rows[0];
  if (next === undefined) return null;
  return (
    <button
      type="button"
      data-scheduled-strip=""
      onClick={props.onOpen}
      onContextMenu={(event) => event.preventDefault()}
      className={cn(
        'flex h-12 w-full shrink-0 items-center gap-3 border-t border-border bg-accent-soft px-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
        NO_TOUCH_SELECT,
      )}
    >
      <IconCalendarClock size={20} className="shrink-0 text-accent" />
      <span className="truncate text-base font-semibold text-fg">
        {scheduledCountLabel(props.rows.length)}
      </span>
      <ScheduledAttachments row={next} size="strip" />
      <span className="ml-auto truncate font-mono text-sm tabular-nums text-fg-2">
        {formatSendLabel(new Date(next.send_at), props.now ?? new Date())}
      </span>
      <IconChevronRight size={16} className="shrink-0 text-fg-2" />
    </button>
  );
}

/** The composer in schedule mode: "Sends <label>" and an x that leaves it. */
export function ScheduleModeStrip(props: { label: string; onStop: () => void }): ReactElement {
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div className="overflow-hidden rounded-md">
      <div
        data-schedule-mode=""
        className={cn(
          'flex min-w-0 items-center gap-2 bg-accent-soft pl-3 transition-transform duration-[180ms] ease-out motion-reduce:transition-none',
          entered ? 'translate-y-0' : 'translate-y-full',
          NO_TOUCH_SELECT,
        )}
      >
        <IconCalendarClock size={18} className="shrink-0 text-accent" />
        <span className="flex-1 truncate text-base font-medium text-fg">Sends {props.label}</span>
        <IconButton label="Stop scheduling" className="shrink-0" onClick={props.onStop}>
          <IconX size={16} />
        </IconButton>
      </div>
    </div>
  );
}
