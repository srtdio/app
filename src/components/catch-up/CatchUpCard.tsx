// One catch-up card (9 Nov 2026): one ITEM (a post, a brief, a plan item, a
// bank idea, a chat, a chat thread). Frame: rounded-2xl, the catch-up-card
// surface (light: panel + hairline; dark: panel-3 + strong edge + the floating
// shadow). First row: the name row (min-h-14, a faint fg tint, hairline under)
// with the centred title and ⌄; a tap opens the ActionMenu (Open <kind>, Copy
// link; no Mute, no Star). While typing on a phone its left slot is Hide
// keyboard and its right slot the ink check (Mark as read + next). Under it,
// on non-chat cards, the context strip (closed). Then the rows in the chat's
// work layout with the "New" line and day lines; the fill rule places the
// scroll; scrolling up loads older rows without moving the reading position.
// The reply box sits at the bottom. Read only: no edit, no resolve. Pure
// render: the screen owns every read and write.

import { useLayoutEffect, useRef } from 'react';
import type { HTMLAttributes, ReactElement, ReactNode, Ref, UIEvent } from 'react';
import { cn } from '@/lib/cn';
import { Text } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { ActionMenu, type ActionMenuItem } from '@/components/ui/ActionMenu';
import {
  ICON_SIZE,
  IconCheck,
  IconCheckCircle,
  IconChevronDown,
  IconEyeOff,
  IconKeyboardHide,
} from '@/components/ui/icons';
import { UnreadDivider } from '@/components/chat/ReadingLayer';
import type { PresignCache } from '@/lib/asset-presign';
import { KEEP_UNREAD, MARK_AS_READ } from '@/lib/catch-up/copy';
import { dayBreaks, fillScrollTop } from '@/lib/catch-up/text';
import type { CatchUpItem } from '@/lib/catch-up/queue';
import type { CatchUpBodyResult, CatchUpMessageRow, CatchUpRow } from '@/lib/catch-up/body';
import {
  BoneRows,
  CardError,
  ContextStrip,
  DayLine,
  EventRow,
  MessageRow,
  PointsRow,
} from '@/components/catch-up/CatchUpRows';

/** A message the person sent from this card: pending, sent, or Not sent (Retry). */
export interface SentMessage extends CatchUpMessageRow {
  state: 'sending' | 'sent' | 'failed';
}

/** How close to the top (px) a scroll asks for older rows. */
const OLDER_AT_PX = 120;

export interface CatchUpCardProps {
  item: CatchUpItem;
  /** The body once read (undefined while it loads: Bone rows keep the footprint). */
  body: CatchUpBodyResult | undefined;
  /** Older rows loaded by scrolling up (oldest first), drawn above the body's rows. */
  older: readonly CatchUpRow[];
  /** Messages sent from this card (appended, newest last). */
  sent: readonly SentMessage[];
  selfName: string | null;
  timeZone?: string | undefined;
  laptop: boolean;
  /** The swipe tint while dragging: read (the accent ink, bg-accent; never green) or keep (soft grey). */
  tint: 'read' | 'keep' | null;
  /** Phone typing: the name row's slots (Hide keyboard, the check). */
  typing: { onHideKeyboard: () => void; onRead: () => void } | null;
  /** The name row's menu. */
  menu: { title: string; items: readonly ActionMenuItem[] };
  /** The reply box (null for a card with none). */
  reply?: ReactNode;
  onRetrySend: (id: string) => void;
  onRetryLoad: () => void;
  /** Open a message's or comment's thread full screen (null rows open none). */
  onOpenThread: (root: CatchUpMessageRow) => void;
  /** Open a feedback point's thread. */
  onOpenPoint: (pointId: string, row: CatchUpRow) => void;
  /** Scroll near the top: load older rows (the screen ignores repeats). */
  onNearTop: () => void;
  cache: PresignCache;
  presignEnabled: boolean;
  onOpenPicture: (pictures: string[], index: number) => void;
  cardRef?: Ref<HTMLDivElement>;
  /** The body's scroller (the screen keeps its position across a thread). */
  bodyRef?: Ref<HTMLDivElement>;
  gesture?: Pick<
    HTMLAttributes<HTMLDivElement>,
    'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel'
  >;
}

function setRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === 'function') ref(value);
  else if (ref !== undefined && ref !== null) (ref as { current: T | null }).current = value;
}

/**
 * The ink check (Mark as read + next) on the typing name row: round 48,
 * primary (bg-accent: black in light, white in dark), never green; it matches
 * Hide keyboard on the left in size and weight.
 */
export function TypingCheck(props: { onPress: () => void }): ReactElement {
  return (
    <Button
      type="button"
      variant="primary"
      shape="round"
      aria-label={MARK_AS_READ}
      data-catch-up-typing-read=""
      className="h-12 w-12"
      // Keep the keyboard until the press lands.
      onPointerDown={(event) => event.preventDefault()}
      onClick={props.onPress}
    >
      <IconCheck size={ICON_SIZE.nav} />
    </Button>
  );
}

export function CatchUpCard(props: CatchUpCardProps): ReactElement {
  const { item, body } = props;
  const chat = item.kind === 'chat-main' || item.kind === 'chat-thread';
  const ready = body !== undefined && body !== 'skip' && body !== 'error' ? body : null;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const placedRef = useRef(false);
  const olderHeightRef = useRef<number | null>(null);
  const rows: CatchUpRow[] = ready !== null ? [...props.older, ...ready.rows] : [];
  const firstRowId = rows[0]?.id ?? null;
  const lastSentId = props.sent[props.sent.length - 1]?.id ?? null;

  // The fill rule, once per card when its rows land: at the "New" line when
  // what follows is taller than the body, else at the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el === null || ready === null || placedRef.current) return;
    placedRef.current = true;
    const line = el.querySelector<HTMLElement>('[data-new-line]');
    el.scrollTop = fillScrollTop({
      newTop: line !== null ? line.offsetTop : null,
      contentHeight: el.scrollHeight,
      bodyHeight: el.clientHeight,
    });
  }, [ready]);

  // Older rows above: keep the reading position (add what grew above).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const before = olderHeightRef.current;
    if (el === null || before === null) return;
    olderHeightRef.current = null;
    el.scrollTop += el.scrollHeight - before;
  }, [firstRowId]);

  // A sent message shows at once (scrolled to the bottom).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el !== null && lastSentId !== null) el.scrollTop = el.scrollHeight;
  }, [lastSentId]);

  const onScroll = (event: UIEvent<HTMLDivElement>): void => {
    const el = event.currentTarget;
    if (ready === null || !ready.hasOlder || el.scrollTop > OLDER_AT_PX) return;
    if (olderHeightRef.current === null) olderHeightRef.current = el.scrollHeight;
    props.onNearTop();
  };

  const breaks = dayBreaks(rows, props.timeZone);
  const drawn: ReactNode[] = [];
  rows.forEach((row, i) => {
    if (breaks.has(i)) {
      drawn.push(
        <DayLine
          key={`day-${row.id}`}
          at={row.createdAt}
          timeZone={props.timeZone}
          laptop={props.laptop}
        />,
      );
    }
    if (ready !== null && row.id === ready.firstNewId)
      drawn.push(<UnreadDivider key="new" count={1} />);
    if (row.kind === 'message') {
      drawn.push(
        <MessageRow
          key={row.id}
          row={row}
          selfName={props.selfName}
          timeZone={props.timeZone}
          onOpenThread={ready?.threads === true ? () => props.onOpenThread(row) : null}
        />,
      );
    } else if (row.kind === 'points') {
      drawn.push(
        <PointsRow
          key={row.id}
          row={row}
          selfName={props.selfName}
          timeZone={props.timeZone}
          onReply={(pointId) => props.onOpenPoint(pointId, row)}
        />,
      );
    } else {
      drawn.push(<EventRow key={row.id} row={row} timeZone={props.timeZone} />);
    }
  });
  for (const message of props.sent) {
    drawn.push(
      <MessageRow
        key={message.id}
        row={message}
        selfName={props.selfName}
        timeZone={props.timeZone}
        onOpenThread={null}
        trailing={
          message.state === 'failed' ? (
            <span data-catch-up-not-sent="" className="flex items-center gap-2">
              <Text role="secondary" className="text-bad">
                Not sent
              </Text>
              <Button variant="ghost" type="button" onClick={() => props.onRetrySend(message.id)}>
                Retry
              </Button>
            </span>
          ) : null
        }
      />,
    );
  }

  const title = ready?.title ?? props.menu.title;
  const nameButton = (
    <button
      type="button"
      data-catch-up-name-row-button=""
      aria-haspopup="menu"
      className="flex min-h-11 min-w-0 max-w-full items-center justify-center gap-1 px-2 focus-visible:lit-focus"
    >
      <Text role="heading" as="h2" data-catch-up-title="" className="min-w-0 truncate">
        {title}
      </Text>
      <span className="shrink-0 text-fg-2">
        <IconChevronDown size={ICON_SIZE.inline} />
      </span>
    </button>
  );

  return (
    <div
      ref={props.cardRef}
      data-catch-up-card={item.key}
      data-catch-up-kind={item.kind}
      {...props.gesture}
      className="catch-up-card relative flex min-h-0 flex-1 touch-pan-y select-none flex-col overflow-hidden rounded-2xl border"
    >
      <div
        data-catch-up-name-row=""
        className="flex min-h-14 shrink-0 items-center gap-2 border-b border-border bg-fg/[0.03] px-2"
      >
        <span className="flex w-12 shrink-0 justify-start">
          {props.typing !== null ? (
            <button
              type="button"
              aria-label="Hide keyboard"
              data-catch-up-hide-keyboard=""
              onPointerDown={(event) => event.preventDefault()}
              onClick={props.typing.onHideKeyboard}
              className="flex h-12 w-12 items-center justify-center rounded-full bg-fg/10 text-fg focus-visible:lit-focus"
            >
              <IconKeyboardHide size={ICON_SIZE.nav} />
            </button>
          ) : null}
        </span>
        <span className="flex min-w-0 flex-1 justify-center">
          <ActionMenu
            title={props.menu.title}
            items={props.menu.items}
            trigger={nameButton}
            align="left"
          />
        </span>
        <span className="flex w-12 shrink-0 justify-end">
          {props.typing !== null ? <TypingCheck onPress={props.typing.onRead} /> : null}
        </span>
      </div>
      {ready?.context != null ? (
        <ContextStrip
          context={ready.context}
          cache={props.cache}
          presignEnabled={props.presignEnabled}
          onOpenPicture={(index) => props.onOpenPicture(ready.context?.pictures ?? [], index)}
        />
      ) : null}
      <div
        ref={(el) => {
          scrollRef.current = el;
          setRef(props.bodyRef, el);
        }}
        data-catch-up-body=""
        onScroll={onScroll}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain"
      >
        {body === 'error' ? (
          <CardError onRetry={props.onRetryLoad} />
        ) : ready === null ? (
          <BoneRows count={chat ? 4 : 3} />
        ) : (
          <>
            {ready.hasOlder ? <BoneRows count={1} /> : null}
            <ul data-catch-up-rows="" className="mt-auto flex flex-col py-2">
              {drawn}
            </ul>
          </>
        )}
      </div>
      {props.reply != null ? (
        // Mid-swipe the card is on its way out: its reply box takes no taps.
        <div
          data-catch-up-reply-slot=""
          aria-hidden={props.tint !== null ? true : undefined}
          className={cn('shrink-0', props.tint !== null && 'pointer-events-none')}
        >
          {props.reply}
        </div>
      ) : null}
      {props.tint !== null ? (
        <div
          aria-hidden="true"
          data-catch-up-tint={props.tint}
          className={cn(
            'pointer-events-none absolute inset-0 z-raised flex flex-col items-center justify-center gap-3',
            props.tint === 'read' ? 'bg-accent text-accent-fg' : 'bg-fg/10 text-fg',
          )}
        >
          {props.tint === 'read' ? (
            <IconCheckCircle size={ICON_SIZE.status} />
          ) : (
            <IconEyeOff size={ICON_SIZE.status} />
          )}
          <Text role="heading" className="text-current">
            {props.tint === 'read' ? MARK_AS_READ : KEEP_UNREAD}
          </Text>
        </div>
      ) : null}
    </div>
  );
}
