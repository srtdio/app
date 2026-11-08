// One catch-up card (8 Nov screens): flat, rounded-2xl, the panel token with
// a hairline. The top: a small kicker and the title, centred, no menu and no
// chevron (a tap on them does nothing). Chat cards draw their messages in the
// chat's work layout (square photo, name, clock time, text, my @name lit with
// MENTION_ME_PEER) with the chat's "New" line before the first unread one,
// scrolled so the newest shows. A thread start draws its card block first.
// Other cards: the entity block, then the comment or plan note text. The reply
// box (when the card takes one) sits at the bottom. Pure render: the screen
// owns every read and write. Tokens only; light and dark at parity.

import { useLayoutEffect, useRef } from 'react';
import type { HTMLAttributes, ReactElement, ReactNode, Ref } from 'react';
import { cn } from '@/lib/cn';
import { Text } from '@/components/ui/Text';
import { Tag } from '@/components/ui/Tag';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { ICON_SIZE, IconCheck, IconCheckCircle, IconEyeOff } from '@/components/ui/icons';
import { UnreadDivider } from '@/components/chat/ReadingLayer';
import { MENTION_ME_PEER } from '@/components/chat/MessageBubble';
import { activityKind } from '@/components/pages/activity/ActivityCard';
import { segmentSelfMentions, type ActivityItem } from '@/components/pages/activity/data';
import { formatTime } from '@/lib/time';
import {
  KEEP_UNREAD,
  MARK_AS_READ,
  catchUpCardKind,
  catchUpKicker,
  catchUpTitle,
  isChatCard,
} from '@/lib/catch-up/copy';
import type { CatchUpChatContent, CatchUpMessage } from '@/lib/catch-up/reads';

/** A message the person sent from this card: pending, sent, or Not sent (Retry). */
export interface SentMessage extends CatchUpMessage {
  state: 'sending' | 'sent' | 'failed';
}

/** A message's text with my own @name lit (MENTION_ME_PEER). */
/** Each run with where it starts in the text: a stable key (runs never move). Pure. */
function withOffsets<T extends { text: string }>(segs: readonly T[]): { seg: T; at: number }[] {
  let at = 0;
  return segs.map((seg) => {
    const out = { seg, at };
    at += seg.text.length;
    return out;
  });
}

function MessageText({ text, selfName }: { text: string; selfName: string | null }): ReactElement {
  return (
    <Text role="body" as="p" className="whitespace-pre-wrap break-words text-fg">
      {withOffsets(segmentSelfMentions(text, selfName)).map(({ seg, at }) =>
        seg.self ? (
          <span key={at} data-catch-up-mention-me="" className={cn('rounded-sm', MENTION_ME_PEER)}>
            {seg.text}
          </span>
        ) : (
          <span key={at}>{seg.text}</span>
        ),
      )}
    </Text>
  );
}

/** One message row in the chat's work layout (everyone on the left, no bubbles). */
function MessageRow(props: {
  message: CatchUpMessage;
  selfName: string | null;
  timeZone: string | undefined;
  trailing?: ReactNode;
}): ReactElement {
  const { message } = props;
  return (
    <li data-catch-up-message={message.id} className="flex gap-3 px-4 py-2">
      <Avatar
        name={message.senderName}
        {...(message.senderAvatarUrl !== null ? { src: message.senderAvatarUrl } : {})}
        role="header"
        decorative
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <Text role="label" className="min-w-0 truncate text-fg">
            {message.senderName}
          </Text>
          <Text role="meta" as="time" dateTime={message.createdAt} className="shrink-0">
            {formatTime(message.createdAt, props.timeZone)}
          </Text>
        </div>
        <MessageText text={message.text} selfName={props.selfName} />
        {props.trailing}
      </div>
    </li>
  );
}

/** The entity block: the kind's one grey tag and the entity's words. */
function EntityBlock({ item }: { item: ActivityItem }): ReactElement | null {
  const kind = activityKind(item);
  const words = item.caption ?? null;
  if (kind === undefined && words === null) return null;
  return (
    <div data-catch-up-entity="" className="flex min-w-0 flex-col gap-2 border-b px-4 py-3">
      {kind !== undefined ? <Tag label={kind} /> : null}
      {words !== null && words.trim() !== '' ? (
        <Text role="secondary" as="p" className="line-clamp-2 whitespace-normal">
          {words}
        </Text>
      ) : null}
    </div>
  );
}

/** A thread start's card block: the card's kind and title, compact and flat. */
function ThreadCardBlock({ item }: { item: ActivityItem }): ReactElement {
  const kind = item.cardKind;
  const label =
    kind === 'brief' ? 'Brief' : kind === 'plan' ? 'Plan' : kind === 'item' ? 'Plan' : 'Post';
  return (
    <div
      data-catch-up-thread-card={kind ?? 'post'}
      className="flex min-w-0 flex-col gap-2 border-b px-4 py-3"
    >
      <Tag label={label} />
      {item.title !== null && item.title !== '' ? (
        <Text role="label" className="truncate text-fg">
          {item.title}
        </Text>
      ) : null}
    </div>
  );
}

export interface CatchUpCardProps {
  item: ActivityItem;
  /** The chat body, once read (undefined while it loads; the card keeps its footprint). */
  content: CatchUpChatContent | undefined;
  /** Messages sent from this card (appended, newest last). */
  sent: readonly SentMessage[];
  selfName: string | null;
  timeZone?: string | undefined;
  /** The swipe tint while dragging: read (green) or keep (ink). */
  tint: 'read' | 'keep' | null;
  /** The typing row (hide-keyboard and the green check), shown while the reply box is focused. */
  typingRow?: ReactNode;
  /** The reply box (null for a card with none). */
  reply?: ReactNode;
  onRetry: (id: string) => void;
  cardRef?: Ref<HTMLDivElement>;
  /** Pointer handlers for the swipe (the screen owns the gesture). */
  gesture?: Pick<
    HTMLAttributes<HTMLDivElement>,
    'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel'
  >;
}

export function CatchUpCard(props: CatchUpCardProps): ReactElement {
  const { item, content } = props;
  const kind = catchUpCardKind(item);
  const chat = isChatCard(kind);
  const title = catchUpTitle(item, content?.threadName ?? null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const loaded = content?.messages ?? [];
  const newest = props.sent[props.sent.length - 1]?.id ?? loaded[loaded.length - 1]?.id;
  // Scrolled so the newest message shows (on load and on each send).
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [newest]);

  const rows: ReactNode[] = [];
  if (chat && content !== undefined) {
    if (content.root !== null) {
      rows.push(
        <MessageRow
          key={`root-${content.root.id}`}
          message={content.root}
          selfName={props.selfName}
          timeZone={props.timeZone}
        />,
      );
    }
    for (const message of content.messages) {
      if (message.id === content.firstNewId) rows.push(<UnreadDivider key="new" count={1} />);
      rows.push(
        <MessageRow
          key={message.id}
          message={message}
          selfName={props.selfName}
          timeZone={props.timeZone}
        />,
      );
    }
  }
  for (const message of props.sent) {
    rows.push(
      <MessageRow
        key={message.id}
        message={message}
        selfName={props.selfName}
        timeZone={props.timeZone}
        trailing={
          message.state === 'failed' ? (
            <span data-catch-up-not-sent="" className="flex items-center gap-2">
              <Text role="secondary" className="text-bad">
                Not sent
              </Text>
              <Button variant="ghost" type="button" onClick={() => props.onRetry(message.id)}>
                Retry
              </Button>
            </span>
          ) : null
        }
      />,
    );
  }

  return (
    <div
      ref={props.cardRef}
      data-catch-up-card={item.id}
      data-catch-up-kind={kind}
      {...props.gesture}
      className="lit-float relative flex min-h-0 flex-1 touch-pan-y select-none flex-col overflow-hidden rounded-2xl border bg-panel"
    >
      {props.typingRow ?? null}
      <div
        data-catch-up-head=""
        className="flex min-w-0 flex-col items-center gap-1 px-4 pb-3 pt-4 text-center"
      >
        <Text role="secondary" as="p" data-catch-up-kicker="" className="max-w-full">
          {catchUpKicker(item)}
        </Text>
        <Text role="heading" as="h2" data-catch-up-title="" className="max-w-full truncate">
          {title}
        </Text>
      </div>
      <div ref={bodyRef} data-catch-up-body="" className="min-h-0 flex-1 overflow-y-auto border-t">
        {kind === 'thread-started' ? <ThreadCardBlock item={item} /> : null}
        {!chat ? <EntityBlock item={item} /> : null}
        {!chat && item.body !== null && item.body.trim() !== '' ? (
          <div data-catch-up-note="" className="px-4 py-3">
            <MessageText text={item.body} selfName={props.selfName} />
          </div>
        ) : null}
        {rows.length > 0 ? <ul className="flex flex-col py-2">{rows}</ul> : null}
      </div>
      {props.reply ?? null}
      {props.tint !== null ? (
        <div
          aria-hidden="true"
          data-catch-up-tint={props.tint}
          className={cn(
            'pointer-events-none absolute inset-0 z-raised flex flex-col items-center justify-center gap-3',
            props.tint === 'read' ? 'bg-good-solid text-accent-fg' : 'bg-fg/90 text-bg',
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

/** The green filled 44 check (Mark as read + next) on the typing row. */
export function TypingCheck(props: { onPress: () => void }): ReactElement {
  return (
    <Button
      type="button"
      variant="success"
      shape="round"
      aria-label={MARK_AS_READ}
      data-catch-up-typing-read=""
      // Keep the keyboard until the press lands.
      onPointerDown={(event) => event.preventDefault()}
      onClick={props.onPress}
    >
      <IconCheck size={ICON_SIZE.nav} />
    </Button>
  );
}
