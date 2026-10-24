// The quoted-reply box, shared by the bubble (a jump button) and the composer's
// reply draft (with a cancel control) so both read identically: an accent bar,
// a panel-3 box, the author in accent and a two-line preview. The composer's
// editing bar takes the same grammar in the warn token, and a quote of a
// deleted message reads its preview italic and muted. Tokens only.
//
// A quote of a message with media reads WhatsApp style: a glyph and "Voice
// message 0:07", "Photo" / "N photos", "Video" or the file name, and for
// images a 36px thumbnail at the end (a body keeps its text, plus the
// thumbnail). It resolves from the message already in memory; the thumbnail
// presigns through the shared cache, its box painted from the first frame.

import type { ReactElement, ReactNode } from 'react';
import { IconCamera, IconFile, IconMic, IconVideo } from '@/components/ui/icons';
import { useAttachmentUrl } from '@/components/chat/MessageAttachments';
import type { PresignCache } from '@/lib/asset-presign';
import { cn } from '@/lib/cn';
import {
  attachmentSummary,
  type AttachmentSummary,
  type AttachmentSummaryIcon,
  type ThreadMessage,
} from '@/lib/chat/thread';
import {
  QUOTE_AUTHOR_TYPE,
  QUOTE_TEXT_TYPE,
  sized,
  type ChatLayout,
} from '@/components/chat/chat-type';

export const REPLY_QUOTE_BOX = 'flex min-w-0 gap-2 overflow-hidden rounded-md bg-panel-3';

/** The rule and author ink: accent for a reply, warn for the editing bar. */
export type QuoteTone = 'accent' | 'warn';

/** The glyph for a summary icon (quote, reply bar, chat list line). */
export function SummaryGlyph(props: {
  icon: AttachmentSummaryIcon;
  size?: number;
  className?: string;
}): ReactElement {
  const glyph = {
    size: props.size ?? 14,
    inline: true,
    ...(props.className !== undefined ? { className: props.className } : {}),
  };
  switch (props.icon) {
    case 'mic':
      return <IconMic {...glyph} />;
    case 'camera':
      return <IconCamera {...glyph} />;
    case 'video':
      return <IconVideo {...glyph} />;
    case 'file':
      return <IconFile {...glyph} />;
  }
}

/**
 * What a quote shows for the quoted message's media: the summary, whether it
 * replaces the text line (no body), and the thumbnail source. Null when the
 * message is not in memory, deleted, or has nothing to add (a text message,
 * or a body with no image). Pure.
 */
export interface QuoteMedia {
  summary: AttachmentSummary;
  /** No body: the line reads the glyph and label instead of the stored text. */
  showLabel: boolean;
}

export function quoteMedia(
  message:
    | (Pick<ThreadMessage, 'body' | 'attachments'> & Partial<Pick<ThreadMessage, 'deleted'>>)
    | undefined,
): QuoteMedia | null {
  if (message === undefined || message.deleted === true) return null;
  const summary = attachmentSummary(message);
  if (summary === null) return null;
  const showLabel = message.body.trim() === '';
  if (
    !showLabel &&
    summary.thumbAssetVersionId === undefined &&
    summary.thumbLocalUrl === undefined
  )
    return null;
  return { summary, showLabel };
}

/** The shared presign cache the quote thumbnail reads through. */
export interface QuoteThumbSource {
  cache: PresignCache;
  presignEnabled: boolean;
}

/** The 36px rounded thumbnail box at the quote's end; it paints before the image. */
function ThumbBox({ src }: { src: string | null }): ReactElement {
  return (
    <span
      data-quote-thumb=""
      className="my-1 mr-1 h-9 w-9 shrink-0 self-center overflow-hidden rounded-md bg-panel-2"
    >
      {src !== null ? (
        <img
          src={src}
          alt=""
          draggable={false}
          className="h-full w-full object-cover [-webkit-touch-callout:none]"
        />
      ) : null}
    </span>
  );
}

/** The thumbnail presigned through the shared cache (a peek paints a cached URL at once). */
function PresignedThumb(props: { assetId: string; source: QuoteThumbSource }): ReactElement {
  const { url } = useAttachmentUrl(props.assetId, props.source.cache, props.source.presignEnabled);
  return <ThumbBox src={url} />;
}

function QuoteThumb(props: {
  summary: AttachmentSummary;
  source: QuoteThumbSource | undefined;
}): ReactElement {
  const local = props.summary.thumbLocalUrl ?? null;
  const assetId = props.summary.thumbAssetVersionId;
  if (local === null && assetId !== undefined && props.source !== undefined) {
    return <PresignedThumb assetId={assetId} source={props.source} />;
  }
  return <ThumbBox src={local} />;
}

function mediaLine(summary: AttachmentSummary): ReactElement {
  return (
    <span data-quote-media={summary.icon} className="flex min-w-0 items-center gap-1">
      <SummaryGlyph icon={summary.icon} className="shrink-0" />
      <span className="min-w-0 truncate">{summary.label}</span>
      {summary.duration !== undefined ? (
        <span className="shrink-0 tabular-nums">{summary.duration}</span>
      ) : null}
    </span>
  );
}

function quoteLines(
  author: string,
  preview: string,
  tone: QuoteTone,
  deleted: boolean,
  inBubble: ChatLayout | undefined,
  media: QuoteMedia | null,
  thumbSource: QuoteThumbSource | undefined,
): ReactElement {
  const label = media !== null && media.showLabel && !deleted;
  const thumb =
    media !== null &&
    !deleted &&
    (media.summary.thumbAssetVersionId !== undefined || media.summary.thumbLocalUrl !== undefined);
  return (
    <>
      <span
        className={cn(
          'w-[3px] shrink-0 self-stretch rounded-full',
          tone === 'warn' ? 'bg-warn' : 'bg-accent',
        )}
        aria-hidden="true"
      />
      <span className="flex min-w-0 flex-1 flex-col py-1 pr-2">
        <span
          className={cn(
            'line-clamp-1 [overflow-wrap:anywhere]',
            inBubble !== undefined
              ? sized(QUOTE_AUTHOR_TYPE, inBubble)
              : 'text-sm font-medium',
            tone === 'warn' ? 'text-warn' : 'text-accent',
          )}
        >
          {author}
        </span>
        <span
          data-quote-deleted={deleted ? '' : undefined}
          className={cn(
            // A media line is one row whose label ellipsizes; text clamps to two.
            label ? 'flex min-w-0' : 'line-clamp-2 [overflow-wrap:anywhere]',
            inBubble !== undefined ? sized(QUOTE_TEXT_TYPE, inBubble) : 'text-sm',
            deleted ? 'italic text-fg-3' : 'text-fg-2',
          )}
        >
          {label && media !== null ? mediaLine(media.summary) : preview}
        </span>
      </span>
      {thumb && media !== null ? <QuoteThumb summary={media.summary} source={thumbSource} /> : null}
    </>
  );
}

/**
 * A quoted reply. With `onJump` the whole box is a 44px button (in a bubble);
 * otherwise a static box with an optional trailing control (the composer's
 * cancel).
 */
export function ReplyQuoteBox(props: {
  author: string;
  preview: string;
  onJump?: () => void;
  trailing?: ReactNode;
  className?: string;
  /** Rule and author ink; accent (a reply) unless given. */
  tone?: QuoteTone;
  /** The quoted message was deleted: the preview reads italic and muted. */
  deleted?: boolean;
  /**
   * Inside a bubble: the chat type scale's quote sizes for this layout (the
   * composer bars keep theirs).
   */
  inBubble?: ChatLayout | undefined;
  /**
   * The quoted message's media (quoteMedia of the message in memory); absent
   * reads the stored preview text only.
   */
  media?: QuoteMedia | null | undefined;
  /** Where the image thumbnail presigns from. */
  thumbSource?: QuoteThumbSource | undefined;
}): ReactElement {
  const tone = props.tone ?? 'accent';
  const deleted = props.deleted === true;
  const inBubble = props.inBubble;
  const media = props.media ?? null;
  if (props.onJump !== undefined) {
    const onJump = props.onJump;
    return (
      <button
        type="button"
        aria-label="Go to quoted message"
        onClick={(e) => {
          e.stopPropagation();
          onJump();
        }}
        className={cn(REPLY_QUOTE_BOX, 'min-h-[44px] w-full text-left', props.className)}
      >
        {quoteLines(props.author, props.preview, tone, deleted, inBubble, media, props.thumbSource)}
      </button>
    );
  }
  return (
    <div className={cn(REPLY_QUOTE_BOX, 'items-center', props.className)}>
      {quoteLines(props.author, props.preview, tone, deleted, inBubble, media, props.thumbSource)}
      {props.trailing}
    </div>
  );
}
