// A catch-up card's body parts (9 Nov 2026), pure render: the chat's work
// layout rows (32 square photo, name label + clock time meta, text body), the
// feedback points (CheckpointCircle in the photo column, centred on the first
// text line), the event rows (actor, time, the line without the name), the
// day lines (DayPill, only when the card spans more than one day), long text
// (>6 lines clamps with a quiet "more" that opens a bordered window that
// scrolls itself), tappable short links, my @name lit (MENTION_ME_PEER), the
// context strip (closed by default, a reading window when open; read only)
// and the error state. Tokens only; light and dark at parity.

import { useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactElement, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Bone, ITEM_OUT, DUR_SLOW_MS, EASE, MOVE_CLASS, play } from '@/lib/motion';
import { Text, textRole } from '@/components/ui/Text';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { PressableRow } from '@/components/ui/PressableRow';
import {
  ICON_SIZE,
  IconAlertTriangle,
  IconChevronDown,
  IconChevronRight,
  IconPlay,
} from '@/components/ui/icons';
import { Thumbnail } from '@/components/media/Thumbnail';
import { CheckpointCircle, CHECKPOINT_HIT_CLASS } from '@/components/comments/CheckpointCircle';
import { DayPill, MENTION_ME_PEER } from '@/components/chat/MessageBubble';
import { useAttachmentUrl } from '@/components/chat/MessageAttachments';
import type { PresignCache } from '@/lib/asset-presign';
import { segmentSelfMentions } from '@/components/pages/activity/data';
import { formatDayLabel, formatTime } from '@/lib/time';
import { linkRuns, overClampLines } from '@/lib/catch-up/text';
import { defaultPointOpen } from '@/lib/catch-up/body';
import type {
  CatchUpAuthor,
  CatchUpContext,
  CatchUpEventRow,
  CatchUpMessageRow,
  CatchUpPointsRow,
} from '@/lib/catch-up/body';

/** Long unbroken words (a 120-character link) wrap anywhere, never overflow. */
export const WRAP_ANYWHERE: CSSProperties = { overflowWrap: 'anywhere' };

/** The rows' side padding: the card's photo column starts here (the composer lines up with it). */
export const CATCH_UP_ROW_X = 'px-4';

/** Characters past which a single-paragraph text clamps even under 6 lines. */
const CLAMP_CHARS = 420;

/** A clip reveal (axis clip, 200 ms ease-ios): the strip and "more" windows open. */
export function clipReveal(el: Element | null): void {
  play(el, ITEM_OUT, [{ clipPath: 'inset(0 0 100% 0)' }, { clipPath: 'inset(0 0 0% 0)' }], {
    duration: DUR_SLOW_MS,
    easing: EASE.ios,
  });
}

/** A text with links (new tab, short labels) and my own @name lit. */
export function RichText(props: {
  text: string;
  selfName: string | null;
  className?: string;
}): ReactElement {
  let at = 0;
  return (
    <Text
      role="body"
      as="p"
      style={WRAP_ANYWHERE}
      className={cn('whitespace-pre-wrap text-fg', props.className)}
    >
      {linkRuns(props.text).map((run) => {
        const key = at;
        if (run.kind === 'link') {
          at += run.href.length;
          return (
            <a
              key={key}
              href={run.href}
              target="_blank"
              rel="noopener noreferrer"
              data-catch-up-link=""
              className="text-fg underline"
            >
              {run.label}
            </a>
          );
        }
        at += run.text.length;
        let inner = 0;
        return (
          <span key={key}>
            {segmentSelfMentions(run.text, props.selfName).map((seg) => {
              const k = inner;
              inner += seg.text.length;
              return seg.self ? (
                <span
                  key={k}
                  data-catch-up-mention-me=""
                  className={cn('rounded-sm', MENTION_ME_PEER)}
                >
                  {seg.text}
                </span>
              ) : (
                <span key={k}>{seg.text}</span>
              );
            })}
          </span>
        );
      })}
    </Text>
  );
}

/**
 * Long text: over 6 lines it clamps with a quiet "more" (secondary, fg-2, 44
 * hit); "more" opens the whole text in a bordered window (max-h-64) that
 * scrolls itself. Never clipped without "more".
 */
export function LongText(props: { text: string; selfName: string | null }): ReactElement {
  const long = overClampLines(props.text) || props.text.length > CLAMP_CHARS;
  const [open, setOpen] = useState(false);
  const windowRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (open) clipReveal(windowRef.current);
  }, [open]);
  if (!long) return <RichText text={props.text} selfName={props.selfName} />;
  if (open) {
    return (
      <div
        ref={windowRef}
        data-catch-up-more-window=""
        className="lit-well max-h-64 overflow-y-auto overscroll-contain rounded-lg border border-border bg-panel-2 p-3"
      >
        <RichText text={props.text} selfName={props.selfName} />
      </div>
    );
  }
  return (
    <div className="flex flex-col items-start">
      <RichText text={props.text} selfName={props.selfName} className="line-clamp-6" />
      <PressableRow
        inline
        type="button"
        data-catch-up-more=""
        onClick={() => setOpen(true)}
        className={textRole(
          'secondary',
          'min-h-11 min-w-11 text-left text-fg-2 focus-visible:lit-focus',
        )}
      >
        more
      </PressableRow>
    </div>
  );
}

/** The row head: 32 square photo column, then name (label, one line) + clock time (meta). */
function RowFrame(props: {
  author: CatchUpAuthor;
  createdAt: string;
  timeZone: string | undefined;
  hook: Record<string, string>;
  under?: ReactNode;
  children: ReactNode;
  photo?: ReactNode;
}): ReactElement {
  return (
    <li {...props.hook} className={cn('flex gap-3 py-2', CATCH_UP_ROW_X)}>
      <span className="w-8 shrink-0">
        {props.photo ?? (
          <Avatar
            name={props.author.name}
            {...(props.author.avatarUrl !== null ? { src: props.author.avatarUrl } : {})}
            role="header"
            decorative
          />
        )}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <Text role="label" className="min-w-0 truncate text-fg" data-catch-up-name="">
            {props.author.name}
          </Text>
          <Text role="meta" as="time" dateTime={props.createdAt} className="shrink-0">
            {formatTime(props.createdAt, props.timeZone)}
          </Text>
        </div>
        {props.under}
        {props.children}
      </div>
    </li>
  );
}

/** "N replies" under a message: opens its thread full screen. */
function RepliesLink(props: { count: number; onOpen: () => void }): ReactElement {
  return (
    <PressableRow
      inline
      type="button"
      data-catch-up-replies=""
      onClick={props.onOpen}
      className={textRole(
        'label',
        'flex min-h-11 min-w-11 items-center self-start text-fg focus-visible:lit-focus',
      )}
    >
      {props.count === 1 ? '1 reply' : `${props.count} replies`}
    </PressableRow>
  );
}

/** A message or a comment in the chat's work layout. */
export function MessageRow(props: {
  row: CatchUpMessageRow;
  selfName: string | null;
  timeZone: string | undefined;
  /** Open its thread (null: the item has no threads, or inside a thread). */
  onOpenThread: (() => void) | null;
  trailing?: ReactNode;
}): ReactElement {
  const { row } = props;
  return (
    <RowFrame
      author={row.author}
      createdAt={row.createdAt}
      timeZone={props.timeZone}
      hook={{ 'data-catch-up-message': row.id }}
    >
      {row.earlierCaption != null && row.earlierCaption !== '' ? (
        <div
          data-catch-up-earlier=""
          className="flex flex-col gap-1 border-l border-border-strong pl-3"
        >
          <Text role="meta">Earlier caption</Text>
          <Text role="body" as="p" style={WRAP_ANYWHERE} className="text-fg-3">
            {row.earlierCaption}
          </Text>
        </div>
      ) : null}
      {props.onOpenThread !== null ? (
        <PressableRow
          type="button"
          data-catch-up-open-thread=""
          onClick={props.onOpenThread}
          className="text-left focus-visible:lit-focus"
        >
          <LongText text={row.text} selfName={props.selfName} />
        </PressableRow>
      ) : (
        <LongText text={row.text} selfName={props.selfName} />
      )}
      {props.onOpenThread !== null && row.replyCount > 0 ? (
        <RepliesLink count={row.replyCount} onOpen={props.onOpenThread} />
      ) : null}
      {props.trailing}
    </RowFrame>
  );
}

/**
 * A feedback batch: the author row + "N checkpoints"; then each point with its
 * CheckpointCircle in the photo column (centred on the first text line: the
 * text block is py-3 on the 20 body line (centre 22), the circle box h-11 (centre 22)), "{n} · {text}" on the
 * message text column, a chevron right. Tap toggles; an open point offers
 * "Reply" (its thread). No Resolve on cards.
 */
export function PointsRow(props: {
  row: CatchUpPointsRow;
  selfName: string | null;
  timeZone: string | undefined;
  onReply: (pointId: string) => void;
}): ReactElement {
  const { row } = props;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(row.points.filter(defaultPointOpen).map((p) => p.id)),
  );
  const toggle = (id: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <>
      <RowFrame
        author={row.author}
        createdAt={row.createdAt}
        timeZone={props.timeZone}
        hook={{ 'data-catch-up-points': row.id }}
        under={
          <Text role="secondary" as="p">
            {row.points.length === 1 ? '1 checkpoint' : `${row.points.length} checkpoints`}
          </Text>
        }
      >
        {null}
      </RowFrame>
      {row.points.map((point) => {
        const isOpen = expanded.has(point.id);
        return (
          <li key={point.id} data-catch-up-point={point.id} data-open={isOpen ? '' : undefined}>
            <PressableRow
              flat
              insetFocus
              type="button"
              aria-expanded={isOpen}
              onClick={() => toggle(point.id)}
              className={cn(
                'flex w-full gap-3 text-left focus-visible:lit-focus-inset',
                CATCH_UP_ROW_X,
              )}
            >
              {/* The photo column (w-8): the 44 circle box centred on the first text line (22 down). */}
              <span className="flex w-8 shrink-0 justify-center">
                <span data-catch-up-point-circle="" className={CHECKPOINT_HIT_CLASS}>
                  <CheckpointCircle n={point.n} state={point.open ? 'open' : 'resolved'} />
                </span>
              </span>
              <span
                data-catch-up-point-text=""
                style={WRAP_ANYWHERE}
                className={cn(
                  'min-w-0 flex-1 py-3',
                  textRole('body'),
                  isOpen ? 'whitespace-pre-wrap text-fg' : 'truncate text-fg-2',
                )}
              >
                {`${point.n} · ${point.text}`}
              </span>
              <span className="flex h-11 shrink-0 items-center text-fg-3">
                <IconChevronRight size={ICON_SIZE.inline} />
              </span>
            </PressableRow>
            {isOpen && point.open ? (
              <div className={cn('flex gap-3', CATCH_UP_ROW_X)}>
                <span className="w-8 shrink-0" />
                <Button
                  type="button"
                  variant="ghost"
                  data-catch-up-point-reply=""
                  onClick={() => props.onReply(point.id)}
                  className="-ml-4"
                >
                  {point.replyCount > 0
                    ? `Reply · ${point.replyCount === 1 ? '1 reply' : `${point.replyCount} replies`}`
                    : 'Reply'}
                </Button>
              </div>
            ) : null}
          </li>
        );
      })}
    </>
  );
}

/** An event with no comment of its own: actor, time, the line without the name. */
export function EventRow(props: {
  row: CatchUpEventRow;
  timeZone: string | undefined;
}): ReactElement {
  return (
    <RowFrame
      author={props.row.author}
      createdAt={props.row.createdAt}
      timeZone={props.timeZone}
      hook={{ 'data-catch-up-event': props.row.id }}
    >
      <Text role="body" as="p" style={WRAP_ANYWHERE} className="text-fg">
        {props.row.line}
      </Text>
    </RowFrame>
  );
}

/** A day line between rows of different days ("Today", "Yesterday", "Fri 9 Oct"). */
export function DayLine(props: {
  at: string;
  timeZone: string | undefined;
  laptop: boolean;
}): ReactElement {
  return (
    <DayPill
      label={formatDayLabel(props.at, new Date(), props.timeZone)}
      layout={props.laptop ? 'laptop' : 'touch'}
    />
  );
}

/** Loading rows (Bone), the rows' own footprint, no spinner. */
export function BoneRows({ count = 3 }: { count?: number }): ReactElement {
  return (
    <ul data-catch-up-bones="" aria-hidden="true" className="flex flex-col py-2">
      {Array.from({ length: count }, (_, place) => `bone-${place}`).map((id) => (
        <li key={id} className={cn('flex gap-3 py-2', CATCH_UP_ROW_X)}>
          <Bone lit="flat" className="h-8 w-8 shrink-0 rounded-lg" />
          <span className="flex min-w-0 flex-1 flex-col gap-2">
            <Bone lit="flat" className="h-4 w-1/3 rounded" />
            <Bone lit="flat" className="h-4 w-3/4 rounded" />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The card's error state: the reply box and buttons stay usable. */
export function CardError(props: { onRetry: () => void }): ReactElement {
  return (
    <div
      data-catch-up-error=""
      role="status"
      className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-8 text-center"
    >
      <span className="text-fg-3">
        <IconAlertTriangle size={ICON_SIZE.status} />
      </span>
      <Text role="label">Couldn&apos;t load this card.</Text>
      <Button type="button" variant="secondary" onClick={props.onRetry}>
        Retry
      </Button>
    </div>
  );
}

/** The big picture in the reading window, with its 1/N marker; tap opens the lightbox. */
function StripPicture(props: {
  pictures: string[];
  cache: PresignCache;
  presignEnabled: boolean;
  onOpen: (index: number) => void;
}): ReactElement {
  const first = props.pictures[0] ?? null;
  return (
    <PressableRow
      type="button"
      data-catch-up-strip-picture=""
      onClick={() => props.onOpen(0)}
      className="relative block h-44 w-full overflow-hidden rounded-lg focus-visible:lit-focus"
    >
      <Thumbnail
        assetVersionId={first}
        cache={props.cache}
        presignEnabled={props.presignEnabled}
        aspect="square"
        fallback={{ kind: 'glyph' }}
        alt="Post picture"
      />
      {props.pictures.length > 1 ? (
        <span
          className={textRole(
            'meta',
            'lit-pill absolute right-2 top-2 rounded-full bg-bg px-2 text-fg',
          )}
        >
          {`1/${props.pictures.length}`}
        </span>
      ) : null}
    </PressableRow>
  );
}

function StripVideo(props: {
  versionId: string;
  cache: PresignCache;
  presignEnabled: boolean;
}): ReactElement {
  const { url } = useAttachmentUrl(props.versionId, props.cache, props.presignEnabled);
  return url !== null ? (
    // A video post plays inline with its controls (muted captions are the post's own).
    <video
      data-catch-up-strip-video=""
      src={url}
      controls
      playsInline
      className="h-44 w-full rounded-lg bg-bg"
    />
  ) : (
    <Bone lit="flat" className="block h-44 w-full rounded-lg" />
  );
}

/**
 * The context strip (non-chat cards), under the name row, closed by default:
 * one min-h-11 row (32 thumbnail, label, due, first line, ⌄). Open: a reading
 * window (max-h-64, scrolls itself): the big picture (1/N; tap opens the
 * lightbox), a video inline, then the full text. Read only. Closing resets
 * its scroll.
 */
export function ContextStrip(props: {
  context: CatchUpContext;
  cache: PresignCache;
  presignEnabled: boolean;
  onOpenPicture: (index: number) => void;
}): ReactElement {
  const { context } = props;
  const [open, setOpen] = useState(false);
  const windowRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (open) clipReveal(windowRef.current);
  }, [open]);
  const firstLine = context.text.split('\n')[0] ?? '';
  const thumb = context.pictures[0] ?? null;
  return (
    <div
      data-catch-up-strip=""
      data-open={open ? '' : undefined}
      className="shrink-0 border-b border-border"
    >
      <PressableRow
        flat
        insetFocus
        type="button"
        aria-expanded={open}
        data-catch-up-strip-toggle=""
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex min-h-11 w-full items-center gap-3 py-1 text-left focus-visible:lit-focus-inset',
          CATCH_UP_ROW_X,
        )}
      >
        {thumb !== null || context.video !== null ? (
          <span className="relative h-8 w-8 shrink-0 overflow-hidden rounded-lg">
            <Thumbnail
              assetVersionId={thumb}
              cache={props.cache}
              presignEnabled={props.presignEnabled}
              aspect="square"
              fallback={{ kind: 'glyph' }}
              alt=""
            />
            {context.video !== null ? (
              <span className="absolute inset-0 flex items-center justify-center text-fg">
                <IconPlay size={ICON_SIZE.inline} />
              </span>
            ) : null}
          </span>
        ) : null}
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <Text role="label" className="shrink-0 text-fg">
            {context.label}
          </Text>
          {context.due !== null ? (
            <Text role="meta" className={cn('shrink-0', context.due.bad && 'text-bad')}>
              {context.due.text}
            </Text>
          ) : null}
          {!open && firstLine !== '' ? (
            <Text role="secondary" className="min-w-0 truncate">
              {firstLine}
            </Text>
          ) : null}
        </span>
        <span className={cn('shrink-0 text-fg-2', MOVE_CLASS.turn, open && 'rotate-180')}>
          <IconChevronDown size={ICON_SIZE.inline} />
        </span>
      </PressableRow>
      {open ? (
        <div
          ref={windowRef}
          data-catch-up-strip-window=""
          className="lit-well mx-4 mb-3 flex max-h-64 flex-col gap-3 overflow-y-auto overscroll-contain rounded-lg border border-border bg-panel-2 p-3"
        >
          {context.video !== null ? (
            <StripVideo
              versionId={context.video}
              cache={props.cache}
              presignEnabled={props.presignEnabled}
            />
          ) : context.pictures.length > 0 ? (
            <StripPicture
              pictures={context.pictures}
              cache={props.cache}
              presignEnabled={props.presignEnabled}
              onOpen={props.onOpenPicture}
            />
          ) : null}
          {context.text !== '' ? (
            <Text role="body" as="p" style={WRAP_ANYWHERE} className="whitespace-pre-wrap text-fg">
              {context.text}
            </Text>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
