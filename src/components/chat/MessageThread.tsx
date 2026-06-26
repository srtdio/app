import { useRef, useState, type MouseEvent, type Ref, type ReactElement } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { IconButton } from '@/components/ui/IconButton';
import { IconChat, IconChevronRight, IconSettings } from '@/components/ui/icons';
import { useLongPress, type LongPressHandlers } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import type { ChatProfile } from '@/lib/chat-reads';
import type { MessageStatus, ThreadMessage } from '@/lib/chat/thread';
import type { MessageAttachment, ReplyQuote } from '@/lib/chat/attachments';
import { useChatAttachments } from '@/lib/chat/use-chat-attachments';
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
  sending: boolean;
  /** False when the channel has no Agora target yet (e.g. group not synced). */
  canSend: boolean;
  onSend: (
    text: string,
    attachments: MessageAttachment[],
    sharedPostIds: string[],
    reply: ReplyQuote | null,
  ) => Promise<void>;
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
  /** True only for DM threads; gates delivery/read ticks on own bubbles. */
  showTicks?: boolean;
  /** Add or remove the current user's reaction on a message. */
  onToggleReaction?: (messageId: string, emoji: string, currentlyMine: boolean) => void;
}

/**
 * Coarse "last seen" label from a timestamp, bucketed minutes/hours/days. Null
 * (no known last-seen) reads as a plain 'Offline'. Computed at render against a
 * supplied now so there is no timer or interval driving the header.
 */
export function lastSeenLabel(lastTimeMs: number | null, nowMs: number): string {
  if (lastTimeMs === null) return 'Offline';
  const mins = Math.floor((nowMs - lastTimeMs) / 60000);
  if (mins < 1) return 'last seen just now';
  if (mins < 60) return `last seen ${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `last seen ${hours}h ago`;
  return `last seen ${Math.floor(hours / 24)}d ago`;
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

function formatTime(time: number): string {
  return new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * WhatsApp-style delivery/read ticks for an own DM message. Single check = sent,
 * double check = delivered, double check in the accent token = read. Inline SVG
 * with token-class colour only, so light and dark stay at parity; no animation.
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
 * above the bubble, while tucked replies reserve an aligned gutter. The
 * timestamp (and own-DM ticks) sit inside the bubble, and reactions hang as one
 * small badge over the tail edge. Pure and hook-free: long-press wiring is owned
 * by the MessageRow wrapper and passed in via `press`, so the unit test can call
 * this directly. All colours are design tokens, so light and dark stay at parity.
 */
export function MessageBubble(props: {
  message: ThreadMessage;
  profiles: Map<string, ChatProfile>;
  cache: PresignCache;
  presignEnabled: boolean;
  showTicks: boolean;
  isGroup: boolean;
  head: boolean;
  onBadgeClick: () => void;
  bubbleRef?: Ref<HTMLDivElement>;
  press?: {
    handlers: LongPressHandlers;
    onContextMenu: (event: MouseEvent) => void;
    consumeClick: () => boolean;
  };
}): ReactElement {
  const { message, profiles, cache, presignEnabled, showTicks, isGroup, head, onBadgeClick } = props;
  const { bubbleRef, press } = props;
  const mine = message.mine;
  const name = senderName(message, profiles);
  const showMeta = isGroup && !mine && head;
  const gutter = isGroup && !mine && !head;
  const hasReactions = message.reactions.length > 0;
  const textOnly =
    message.body.trim() !== '' &&
    message.attachments.length === 0 &&
    message.sharedPostIds.length === 0;
  const totalReactions = message.reactions.reduce((sum, r) => sum + r.count, 0);
  const distinctEmojis = message.reactions.map((r) => r.emoji).join('');
  const time = (
    <>
      <span>{formatTime(message.time)}</span>
      {showTicks && mine ? <MessageTicks status={message.status} /> : null}
    </>
  );
  return (
    <li
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
          {...press?.handlers}
          onContextMenu={press?.onContextMenu}
          onClickCapture={(e) => {
            if (press?.consumeClick()) {
              e.preventDefault();
              e.stopPropagation();
            }
          }}
          className={cn(
            'relative select-none [-webkit-touch-callout:none] rounded-2xl border px-3 py-2',
            mine
              ? 'rounded-br-sm border-accent-line bg-accent-soft'
              : 'rounded-bl-sm border-border bg-panel-2',
          )}
        >
          {message.reply !== null ? (
            <div className="mb-1 flex items-start gap-2 rounded-md border-l-2 border-accent bg-panel px-2 py-1">
              <span className="flex min-w-0 flex-col">
                <span className="text-xs font-medium text-accent">
                  {message.reply.authorUserId !== null
                    ? (profiles.get(message.reply.authorUserId)?.displayName ?? 'Member')
                    : 'Member'}
                </span>
                <span className="truncate text-xs text-fg-3">{message.reply.preview}</span>
              </span>
            </div>
          ) : null}
          {textOnly ? (
            <>
              <p className="whitespace-pre-wrap break-words text-sm text-fg-2">
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
                <p className="whitespace-pre-wrap break-words text-sm text-fg-2">{message.body}</p>
              ) : null}
              <MessageAttachments
                attachments={message.attachments}
                cache={cache}
                presignEnabled={presignEnabled}
              />
              {/* PR6 'post' extension point: shared posts resolve + render here,
                  separate from the attachment branch above. */}
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
  onOpen: (message: ThreadMessage, rect: DOMRect | null) => void;
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
      bubbleRef={bubbleRef}
      press={{ handlers, onContextMenu, consumeClick: consumeClickSuppression }}
      onBadgeClick={() =>
        props.onOpen(props.message, bubbleRef.current?.getBoundingClientRect() ?? null)
      }
    />
  );
}

function ThreadBody(
  props: Pick<MessageThreadProps, 'messages' | 'loading' | 'profiles' | 'onToggleReaction'> & {
    cache: PresignCache;
    presignEnabled: boolean;
    showTicks: boolean;
    isGroup: boolean;
    onReply: (message: ThreadMessage) => void;
  },
): ReactElement {
  const [menu, setMenu] = useState<{ message: ThreadMessage; rect: DOMRect | null } | null>(null);
  const toast = useToast();
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
      <ul className="flex-1 overflow-y-auto py-2">
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
            onOpen={(m, rect) => setMenu({ message: m, rect })}
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
          if (menu)
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
  const { canAttach, presignEnabled, presignCache, uploadFile } = useChatAttachments();
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
                : lastSeenLabel(props.presence.lastTimeMs, Date.now())}
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
        messages={props.messages}
        loading={props.loading}
        profiles={props.profiles}
        cache={presignCache}
        presignEnabled={presignEnabled}
        showTicks={props.showTicks ?? false}
        isGroup={props.isGroup ?? false}
        onReply={handleReply}
        {...(props.onToggleReaction !== undefined
          ? { onToggleReaction: props.onToggleReaction }
          : {})}
      />
      <TypingIndicator ids={props.typingUserIds} profiles={props.profiles} />
      <Composer
        onSend={props.onSend}
        disabled={!props.canSend || props.sending}
        onTyping={props.onTyping}
        onCancelReply={() => setReplyDraft(null)}
        {...(replyDraft !== null ? { reply: replyDraft } : {})}
        {...(canAttach ? { uploadFile } : {})}
      />
    </div>
  );
}
