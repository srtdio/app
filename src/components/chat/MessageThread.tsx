import {
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type Ref,
  type ReactElement,
} from 'react';
import { isNearBottom } from '@/lib/chat/scroll';
import { Avatar } from '@/components/ui/Avatar';
import { IconButton } from '@/components/ui/IconButton';
import { IconChat, IconChevronRight, IconRotateCcw, IconSettings } from '@/components/ui/icons';
import { useLongPress, type LongPressHandlers } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import type { ChatProfile } from '@/lib/chat-reads';
import type { MessageStatus, ThreadMessage } from '@/lib/chat/thread';
import type { MessageAttachment, ReplyQuote } from '@/lib/chat/attachments';
import { useChatAttachments } from '@/lib/chat/use-chat-attachments';
import { formatMessageTime } from '@/lib/chat/time-format';
import type { PresignCache } from '@/lib/asset-presign';
import { Composer } from '@/components/chat/Composer';
import { MessageAttachments } from '@/components/chat/MessageAttachments';
import { SharedPostCards } from '@/components/chat/PostCard';
import { MessageActionMenu } from '@/components/chat/MessageActionMenu';

interface MessageThreadProps {
  title: string;
  /** Sender display info keyed by Sorted user id; batched read, never per-row. */
  profiles: Map<string, ChatProfile>;
  messages: ThreadMessage[];
  loading: boolean;
  /** An older page is loading (scroll-to-top); renders a slim row at the top. */
  loadingOlder?: boolean;
  /** Whether scrolling to the top should request an older page. */
  hasMore?: boolean;
  onLoadOlder?: () => void;
  /** The newest message is on screen; the thread advances the read cursor. */
  onNewestVisible?: () => void;
  /** The workspace IANA zone every timestamp renders in. */
  timeZone: string;
  /** False when sending is impossible (no channel selected). */
  canSend: boolean;
  onSend: (
    text: string,
    attachments: MessageAttachment[],
    sharedPostIds: string[],
    reply: ReplyQuote | null,
  ) => Promise<void>;
  /** Re-run a failed send with the same message id. */
  onRetry?: (messageId: string) => void;
  /** Present on small screens only; renders a back affordance to the list. */
  onBack?: () => void;
  /** Present for group channels only; opens the group management panel. */
  onOpenInfo?: () => void;
  /** True for group channels; drives per-run avatars and sender names. Absent = DM. */
  isGroup?: boolean;
  /** Sorted user ids currently typing (peers only); drives the indicator row. */
  typingUserIds: string[];
  /** Forwarded to the composer so each keystroke broadcasts a typing signal. */
  onTyping?: () => void;
  /** DM peer presence; absent for groups. Renders a header status line when available. */
  presence?: { online: boolean; lastTimeMs: number | null; available: boolean };
  /** True only for DM threads; gates seen ticks on own bubbles. */
  showTicks?: boolean;
  /** Add or remove the current user's reaction on a message. */
  onToggleReaction?: (messageId: string, emoji: string, currentlyMine: boolean) => void;
}

/** Scroll positions within this many px of the top request the older page. */
const LOAD_OLDER_THRESHOLD_PX = 80;

/**
 * Coarse "last seen" label from a timestamp, bucketed minutes/hours/days. Null
 * (no known last-seen) reads as a plain 'Offline'. Computed at render against a
 * supplied now so there is no timer or interval driving the header. Beyond a
 * day it shows the workspace-zone clock time of the last visit.
 */
export function lastSeenLabel(lastTimeMs: number | null, nowMs: number, timeZone: string): string {
  if (lastTimeMs === null) return 'Offline';
  const mins = Math.floor((nowMs - lastTimeMs) / 60000);
  if (mins < 1) return 'last seen just now';
  if (mins < 60) return `last seen ${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `last seen ${hours}h ago`;
  return `last seen ${Math.floor(hours / 24)}d ago at ${formatMessageTime(lastTimeMs, timeZone)}`;
}

/**
 * Human label for who is typing, capped so the row never grows: one or two known
 * names are spelled out, otherwise a count or a generic phrase. Returns null
 * when nobody is typing so the indicator renders nothing.
 */
function typingLabel(ids: string[], profiles: Map<string, ChatProfile>): string | null {
  if (ids.length === 0) return null;
  if (ids.length === 1) {
    const name = profiles.get(ids[0] as string)?.displayName;
    return `${name ?? 'Someone'} is typing`;
  }
  if (ids.length === 2) {
    const a = profiles.get(ids[0] as string)?.displayName;
    const b = profiles.get(ids[1] as string)?.displayName;
    return a !== undefined && b !== undefined ? `${a} and ${b} are typing` : '2 people are typing';
  }
  return 'Several people are typing';
}

/**
 * Slim, non-scrolling typing row shown just above the composer. The three dots
 * animate opacity-only via `animate-pulse` with staggered arbitrary delays (no
 * translate/rotate, no custom keyframes), and all colours are design tokens so
 * light and dark are at parity.
 */
function TypingIndicator(props: {
  ids: string[];
  profiles: Map<string, ChatProfile>;
}): ReactElement | null {
  const label = typingLabel(props.ids, props.profiles);
  if (label === null) return null;
  return (
    <div className="flex shrink-0 items-center gap-2 px-4 py-1.5 text-xs text-fg-3">
      <span className="flex items-center gap-1" aria-hidden="true">
        <span className="h-1.5 w-1.5 rounded-full bg-fg-3 animate-pulse [animation-delay:0ms]" />
        <span className="h-1.5 w-1.5 rounded-full bg-fg-3 animate-pulse [animation-delay:150ms]" />
        <span className="h-1.5 w-1.5 rounded-full bg-fg-3 animate-pulse [animation-delay:300ms]" />
      </span>
      <span>{label}</span>
    </div>
  );
}

function senderName(message: ThreadMessage, profiles: Map<string, ChatProfile>): string {
  if (message.mine) return 'You';
  const profile = message.senderUserId !== null ? profiles.get(message.senderUserId) : undefined;
  return profile?.displayName ?? 'Unknown';
}

function senderAvatarProps(
  message: ThreadMessage,
  profiles: Map<string, ChatProfile>,
): { src: string } | Record<string, never> {
  const profile = message.senderUserId !== null ? profiles.get(message.senderUserId) : undefined;
  return profile?.avatarUrl != null ? { src: profile.avatarUrl } : {};
}

/**
 * The footer label for a bubble: the server time on the workspace clock once
 * the message is recorded, 'Sending' while the record write is in flight, and
 * 'Not sent' when it failed (the Retry control sits beside it).
 */
export function bubbleTimeLabel(message: ThreadMessage, timeZone: string): string {
  if (message.state === 'sending') return 'Sending';
  if (message.state === 'failed') return 'Not sent';
  return formatMessageTime(message.createdAt, timeZone);
}

/**
 * WhatsApp-style seen ticks for an own DM message. Single check = recorded,
 * double check in the accent token = read by the peer. Inline SVG with
 * token-class colour only, so light and dark stay at parity; no animation.
 */
function MessageTicks({ status }: { status: MessageStatus }): ReactElement {
  const color = status === 'read' ? 'text-accent' : 'text-fg-3';
  return (
    <span className={cn('inline-flex items-center', color)} aria-hidden="true">
      {status === 'sent' ? (
        <svg
          width="16"
          height="12"
          viewBox="0 0 16 12"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.7}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M2 7l3.5 3.5L14 2" />
        </svg>
      ) : (
        <svg
          width="20"
          height="12"
          viewBox="0 0 20 12"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.7}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M2 7l3.5 3.5L11 2" />
          <path d="M8 7l3.5 3.5L18 2" />
        </svg>
      )}
    </span>
  );
}

/**
 * One message row in the WhatsApp-style thread. Own messages (`message.mine`)
 * right-align with an accent-tinted bubble, no avatar and no sender name. Peer
 * messages left-align; in a group the run head carries the avatar + sender name
 * above the bubble, while tucked replies reserve an aligned gutter. The footer
 * (server time on the workspace clock, or the sending / not-sent state, and
 * own-DM ticks) sits inside the bubble; a failed own send offers a 44px Retry
 * beside the bubble; reactions hang as one small badge over the tail edge.
 * Pure and hook-free: long-press wiring is owned by the MessageRow wrapper and
 * passed in via `press`, so the unit test can call this directly. All colours
 * are design tokens, so light and dark stay at parity.
 */
export function MessageBubble(props: {
  message: ThreadMessage;
  profiles: Map<string, ChatProfile>;
  cache: PresignCache;
  presignEnabled: boolean;
  showTicks: boolean;
  isGroup: boolean;
  head: boolean;
  timeZone: string;
  onBadgeClick: () => void;
  onRetry?: (messageId: string) => void;
  onJumpToMessage?: (messageId: string) => void;
  bubbleRef?: Ref<HTMLDivElement>;
  press?: {
    handlers: LongPressHandlers;
    onContextMenu: (event: MouseEvent) => void;
    consumeClick: () => boolean;
  };
}): ReactElement {
  const { message, profiles, cache, presignEnabled, showTicks, isGroup, head, onBadgeClick } =
    props;
  const { bubbleRef, press, timeZone } = props;
  const mine = message.mine;
  const reply = message.reply;
  const name = senderName(message, profiles);
  const showMeta = isGroup && !mine && head;
  const gutter = isGroup && !mine && !head;
  const hasReactions = message.reactions.length > 0;
  const failed = message.state === 'failed';
  const sending = message.state === 'sending';
  const textOnly =
    message.body.trim() !== '' &&
    message.attachments.length === 0 &&
    message.sharedPostIds.length === 0;
  const totalReactions = message.reactions.reduce((sum, r) => sum + r.count, 0);
  const distinctEmojis = message.reactions.map((r) => r.emoji).join('');
  const time = (
    <>
      <span className={cn(failed && 'text-bad')}>{bubbleTimeLabel(message, timeZone)}</span>
      {showTicks && mine && !failed && !sending ? <MessageTicks status={message.status} /> : null}
    </>
  );
  return (
    <li
      data-msg-id={message.id}
      data-state={message.state}
      className={cn(
        'flex items-start gap-2 px-4 py-2',
        mine ? 'flex-row-reverse' : 'flex-row',
        hasReactions && 'mb-3',
      )}
    >
      {showMeta ? <Avatar name={name} {...senderAvatarProps(message, profiles)} size="md" /> : null}
      {gutter ? <span className="w-[26px] shrink-0" aria-hidden="true" /> : null}
      <div className={cn('flex min-w-0 max-w-[75%] flex-col gap-1', mine && 'items-end')}>
        {showMeta ? <span className="text-sm font-medium text-fg">{name}</span> : null}
        <div
          ref={bubbleRef}
          data-bubble=""
          {...press?.handlers}
          onContextMenu={press?.onContextMenu}
          onClickCapture={(e) => {
            if (press?.consumeClick()) {
              e.preventDefault();
              e.stopPropagation();
            }
          }}
          className={cn(
            'relative min-w-0 select-none [-webkit-touch-callout:none] rounded-2xl border px-3 py-2',
            mine
              ? 'rounded-br-sm border-accent-line bg-accent-soft'
              : 'rounded-bl-sm border-border bg-panel-2',
            sending && 'opacity-70',
            failed && 'border-bad',
          )}
        >
          {reply !== null ? (
            <button
              type="button"
              aria-label="Go to quoted message"
              onClick={(e) => {
                e.stopPropagation();
                props.onJumpToMessage?.(reply.id);
              }}
              className="mb-1 flex min-h-[44px] w-full min-w-0 gap-2 overflow-hidden rounded-md bg-panel-3 text-left"
            >
              <span
                className="w-[3.5px] shrink-0 self-stretch rounded-full bg-accent"
                aria-hidden="true"
              />
              <span className="flex min-w-0 flex-col py-1 pr-2">
                <span className="line-clamp-1 [overflow-wrap:anywhere] text-xs font-medium text-accent">
                  {reply.authorUserId !== null
                    ? (profiles.get(reply.authorUserId)?.displayName ?? 'Member')
                    : 'Member'}
                </span>
                <span className="line-clamp-2 [overflow-wrap:anywhere] text-xs text-fg-2">
                  {reply.preview}
                </span>
              </span>
            </button>
          ) : null}
          {textOnly ? (
            <>
              <p className="whitespace-pre-wrap [overflow-wrap:anywhere] text-sm text-fg-2">
                {message.body}
                <span
                  className={cn('inline-block', mine ? 'w-[74px]' : 'w-[52px]')}
                  aria-hidden="true"
                />
              </p>
              <span className="absolute bottom-1.5 right-2.5 inline-flex items-center gap-1 text-[10px] text-fg-3">
                {time}
              </span>
            </>
          ) : (
            <>
              {message.body.trim() !== '' ? (
                <p className="whitespace-pre-wrap [overflow-wrap:anywhere] text-sm text-fg-2">
                  {message.body}
                </p>
              ) : null}
              <MessageAttachments
                attachments={message.attachments}
                cache={cache}
                presignEnabled={presignEnabled}
              />
              <SharedPostCards postIds={message.sharedPostIds} />
              <div className="mt-1 flex items-center justify-end gap-1 text-[10px] text-fg-3">
                {time}
              </div>
            </>
          )}
          {hasReactions ? (
            <button
              type="button"
              onClick={onBadgeClick}
              className={cn(
                'absolute -bottom-2.5 inline-flex items-center gap-0.5 rounded-full border border-border bg-panel px-1.5 py-0.5 text-xs shadow-sm',
                mine ? 'right-2' : 'left-2',
              )}
            >
              <span aria-hidden="true">{distinctEmojis}</span>
              {totalReactions > 1 ? (
                <span className="text-[11px] text-fg-3">{totalReactions}</span>
              ) : null}
            </button>
          ) : null}
        </div>
      </div>
      {failed && mine ? (
        <IconButton
          label="Retry sending"
          className="shrink-0 self-center text-bad hover:bg-bad-soft hover:text-bad"
          onClick={() => props.onRetry?.(message.id)}
        >
          <IconRotateCcw size={18} />
        </IconButton>
      ) : null}
    </li>
  );
}

/** First in a run, a switch between own/peer, or a different peer sender starts a head. */
function isHead(prev: ThreadMessage | undefined, m: ThreadMessage): boolean {
  if (prev === undefined) return true;
  if (prev.mine !== m.mine) return true;
  if (!prev.mine && !m.mine && prev.senderUserId !== m.senderUserId) return true;
  return false;
}

/**
 * Thin wrapper that owns the long-press / right-click wiring for one bubble and
 * keeps MessageBubble pure. The bubble's rect is captured on open so the floating
 * action menu can anchor to it.
 */
function MessageRow(props: {
  message: ThreadMessage;
  profiles: Map<string, ChatProfile>;
  cache: PresignCache;
  presignEnabled: boolean;
  showTicks: boolean;
  isGroup: boolean;
  head: boolean;
  timeZone: string;
  onOpen: (message: ThreadMessage, rect: DOMRect | null) => void;
  onRetry?: (messageId: string) => void;
  onJumpToMessage?: (messageId: string) => void;
}): ReactElement {
  const bubbleRef = useRef<HTMLDivElement>(null);
  const { handlers, consumeClickSuppression } = useLongPress(() =>
    props.onOpen(props.message, bubbleRef.current?.getBoundingClientRect() ?? null),
  );
  const onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
    props.onOpen(props.message, bubbleRef.current?.getBoundingClientRect() ?? null);
  };
  return (
    <MessageBubble
      message={props.message}
      profiles={props.profiles}
      cache={props.cache}
      presignEnabled={props.presignEnabled}
      showTicks={props.showTicks}
      isGroup={props.isGroup}
      head={props.head}
      timeZone={props.timeZone}
      bubbleRef={bubbleRef}
      press={{ handlers, onContextMenu, consumeClick: consumeClickSuppression }}
      {...(props.onRetry !== undefined ? { onRetry: props.onRetry } : {})}
      {...(props.onJumpToMessage !== undefined ? { onJumpToMessage: props.onJumpToMessage } : {})}
      onBadgeClick={() =>
        props.onOpen(props.message, bubbleRef.current?.getBoundingClientRect() ?? null)
      }
    />
  );
}

function ThreadBody(
  props: Pick<
    MessageThreadProps,
    | 'title'
    | 'messages'
    | 'loading'
    | 'loadingOlder'
    | 'hasMore'
    | 'onLoadOlder'
    | 'onNewestVisible'
    | 'profiles'
    | 'onToggleReaction'
    | 'onRetry'
    | 'timeZone'
  > & {
    cache: PresignCache;
    presignEnabled: boolean;
    showTicks: boolean;
    isGroup: boolean;
    onReply: (message: ThreadMessage) => void;
  },
): ReactElement {
  const { onNewestVisible } = props;
  const [menu, setMenu] = useState<{ message: ThreadMessage; rect: DOMRect | null } | null>(null);
  const toast = useToast();
  const listRef = useRef<HTMLUListElement>(null);
  // Tracks whether we have already snapped a freshly opened conversation to the
  // latest message, and whether the reader is currently parked at the bottom.
  const didInitialScrollRef = useRef(false);
  const atBottomRef = useRef(true);
  // The scroll height before an older page was requested, so the prepended rows
  // do not move what the reader was looking at.
  const anchorHeightRef = useRef<number | null>(null);
  const newestIdRef = useRef<string | null>(null);
  // Reset on conversation switch so a fresh thread always lands at the latest
  // message even if the previous one was scrolled up. `title` is the only
  // per-conversation identifier reaching this component. Declared BEFORE the
  // messages effect so the reset commits first on a switch.
  useLayoutEffect(() => {
    didInitialScrollRef.current = false;
    atBottomRef.current = true;
    anchorHeightRef.current = null;
    newestIdRef.current = null;
  }, [props.title]);
  // Keep the latest message in view: instant pre-paint snap on first load (no
  // top-flash), then a smooth follow for own sends or when already at bottom.
  // After an older page is prepended, restore the reader's position instead.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el === null || props.messages.length === 0) return;
    if (anchorHeightRef.current !== null) {
      el.scrollTop += el.scrollHeight - anchorHeightRef.current;
      anchorHeightRef.current = null;
      return;
    }
    const last = props.messages[props.messages.length - 1];
    if (!didInitialScrollRef.current) {
      el.scrollTop = el.scrollHeight;
      didInitialScrollRef.current = true;
    } else if (last !== undefined && (last.mine || atBottomRef.current)) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }
    if (last !== undefined && atBottomRef.current && newestIdRef.current !== last.id) {
      newestIdRef.current = last.id;
      onNewestVisible?.();
    }
  }, [props.messages, onNewestVisible]);
  const scrollToMessage = (id: string): void => {
    const el = listRef.current?.querySelector(`[data-msg-id="${CSS.escape(id)}"]`);
    if (el == null) {
      toast.show({ title: 'That message is not loaded here' });
      return;
    }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const flash = el.querySelector('[data-bubble]') ?? el;
    const ring = ['ring-2', 'ring-accent', 'ring-inset'];
    flash.classList.add(...ring);
    window.setTimeout(() => flash.classList.remove(...ring), 1200);
  };
  if (props.loading) {
    return <div className="flex-1 px-4 py-6 text-sm text-fg-3">Loading messages</div>;
  }
  if (props.messages.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-fg-3">
        <IconChat size={22} />
        <span className="text-sm">No messages yet</span>
      </div>
    );
  }
  return (
    <>
      <ul
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          const wasAtBottom = atBottomRef.current;
          atBottomRef.current = isNearBottom(el.scrollTop, el.scrollHeight, el.clientHeight);
          if (atBottomRef.current && !wasAtBottom) {
            const last = props.messages[props.messages.length - 1];
            if (last !== undefined && newestIdRef.current !== last.id) {
              newestIdRef.current = last.id;
              props.onNewestVisible?.();
            }
          }
          if (
            el.scrollTop <= LOAD_OLDER_THRESHOLD_PX &&
            props.hasMore === true &&
            props.loadingOlder !== true &&
            anchorHeightRef.current === null
          ) {
            anchorHeightRef.current = el.scrollHeight;
            props.onLoadOlder?.();
          }
        }}
        className="flex-1 overflow-y-auto py-2"
      >
        {props.loadingOlder === true ? (
          <li className="px-4 py-2 text-center text-xs text-fg-3">Loading earlier messages</li>
        ) : null}
        {props.messages.map((message, i) => (
          <MessageRow
            key={message.id}
            message={message}
            profiles={props.profiles}
            cache={props.cache}
            presignEnabled={props.presignEnabled}
            showTicks={props.showTicks}
            isGroup={props.isGroup}
            head={isHead(props.messages[i - 1], message)}
            timeZone={props.timeZone}
            onOpen={(m, rect) => setMenu({ message: m, rect })}
            onJumpToMessage={scrollToMessage}
            {...(props.onRetry !== undefined ? { onRetry: props.onRetry } : {})}
          />
        ))}
      </ul>
      <MessageActionMenu
        open={menu !== null}
        onClose={() => setMenu(null)}
        anchor={menu?.rect ?? null}
        mine={menu?.message.mine ?? false}
        currentReaction={menu ? (menu.message.reactions.find((r) => r.mine)?.emoji ?? null) : null}
        canCopy={menu ? menu.message.body.trim() !== '' : false}
        onReact={(emoji) => {
          if (menu && menu.message.state === 'sent')
            props.onToggleReaction?.(
              menu.message.id,
              emoji,
              menu.message.reactions.find((r) => r.mine)?.emoji === emoji,
            );
        }}
        onReply={() => {
          if (menu) props.onReply(menu.message);
        }}
        onCopy={() => {
          if (menu) {
            void navigator.clipboard?.writeText(menu.message.body);
            toast.show({ title: 'Message copied' });
          }
        }}
      />
    </>
  );
}

/** The thread pane: header (+ optional back), message list, and composer. */
export function MessageThread(props: MessageThreadProps): ReactElement {
  const { canAttach, presignEnabled, presignCache, uploadFile, transcribe, canTranscribe } =
    useChatAttachments();
  const [replyDraft, setReplyDraft] = useState<{ authorName: string; quote: ReplyQuote } | null>(
    null,
  );
  const handleReply = (message: ThreadMessage): void => {
    const body = message.body.trim();
    const preview =
      body !== ''
        ? body.length > 120
          ? `${body.slice(0, 120)}…`
          : body
        : message.attachments.length > 0
          ? 'Attachment'
          : message.sharedPostIds.length > 0
            ? 'Shared post'
            : 'Message';
    setReplyDraft({
      authorName: senderName(message, props.profiles),
      quote: { id: message.id, authorUserId: message.senderUserId, preview },
    });
  };
  return (
    <div className="flex h-full flex-col bg-panel">
      <div className="flex items-center gap-2 border-b border-border px-2 md:px-4 h-14">
        {props.onBack !== undefined ? (
          <IconButton label="Back to conversations" onClick={props.onBack}>
            <IconChevronRight size={20} className="rotate-180" />
          </IconButton>
        ) : null}
        <div className={cn('min-w-0 flex-1', props.onBack === undefined && 'px-2')}>
          <span className="block truncate text-sm font-semibold text-fg">{props.title}</span>
          {props.presence !== undefined && props.presence.available ? (
            <span className="flex items-center gap-1.5 text-xs text-fg-3">
              <span
                className={cn(
                  'h-2 w-2 rounded-full',
                  props.presence.online ? 'bg-good' : 'bg-fg-3',
                )}
              />
              {props.presence.online
                ? 'Online'
                : lastSeenLabel(props.presence.lastTimeMs, Date.now(), props.timeZone)}
            </span>
          ) : null}
        </div>
        {props.onOpenInfo !== undefined ? (
          <IconButton label="Group info" onClick={props.onOpenInfo}>
            <IconSettings size={20} />
          </IconButton>
        ) : null}
      </div>
      <ThreadBody
        title={props.title}
        messages={props.messages}
        loading={props.loading}
        profiles={props.profiles}
        cache={presignCache}
        presignEnabled={presignEnabled}
        showTicks={props.showTicks ?? false}
        isGroup={props.isGroup ?? false}
        timeZone={props.timeZone}
        onReply={handleReply}
        {...(props.loadingOlder !== undefined ? { loadingOlder: props.loadingOlder } : {})}
        {...(props.hasMore !== undefined ? { hasMore: props.hasMore } : {})}
        {...(props.onLoadOlder !== undefined ? { onLoadOlder: props.onLoadOlder } : {})}
        {...(props.onNewestVisible !== undefined ? { onNewestVisible: props.onNewestVisible } : {})}
        {...(props.onRetry !== undefined ? { onRetry: props.onRetry } : {})}
        {...(props.onToggleReaction !== undefined
          ? { onToggleReaction: props.onToggleReaction }
          : {})}
      />
      <TypingIndicator ids={props.typingUserIds} profiles={props.profiles} />
      <Composer
        onSend={props.onSend}
        disabled={!props.canSend}
        onTyping={props.onTyping}
        onCancelReply={() => setReplyDraft(null)}
        {...(replyDraft !== null ? { reply: replyDraft } : {})}
        {...(canAttach ? { uploadFile } : {})}
        {...(canTranscribe ? { transcribe } : {})}
      />
    </div>
  );
}
