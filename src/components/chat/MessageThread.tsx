import type { ReactElement } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { IconButton } from '@/components/ui/IconButton';
import { IconChat, IconChevronRight, IconSettings } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import type { ChatProfile } from '@/lib/chat-reads';
import type { ThreadMessage } from '@/lib/chat/thread';
import type { MessageAttachment } from '@/lib/chat/attachments';
import { useChatAttachments } from '@/lib/chat/use-chat-attachments';
import type { PresignCache } from '@/lib/asset-presign';
import { Composer } from '@/components/chat/Composer';
import { MessageAttachments } from '@/components/chat/MessageAttachments';
import { SharedPostCards } from '@/components/chat/PostCard';

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
  ) => Promise<void>;
  /** Present on small screens only; renders a back affordance to the list. */
  onBack?: () => void;
  /** Present for group channels only; opens the group management panel. */
  onOpenInfo?: () => void;
  /** Sorted user ids currently typing (peers only); drives the indicator row. */
  typingUserIds: string[];
  /** Forwarded to the composer so each keystroke broadcasts a typing signal. */
  onTyping?: () => void;
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

function MessageBubble(props: {
  message: ThreadMessage;
  profiles: Map<string, ChatProfile>;
  cache: PresignCache;
  presignEnabled: boolean;
}): ReactElement {
  const { message, profiles, cache, presignEnabled } = props;
  const name = senderName(message, profiles);
  return (
    <li className="flex gap-3 px-4 py-2">
      <Avatar name={name} {...senderAvatarProps(message, profiles)} size="md" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium text-fg">{name}</span>
          <span className="text-xs text-fg-3">{formatTime(message.time)}</span>
        </div>
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
      </div>
    </li>
  );
}

function ThreadBody(
  props: Pick<MessageThreadProps, 'messages' | 'loading' | 'profiles'> & {
    cache: PresignCache;
    presignEnabled: boolean;
  },
): ReactElement {
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
    <ul className="flex-1 overflow-y-auto py-2">
      {props.messages.map((message) => (
        <MessageBubble
          key={message.id}
          message={message}
          profiles={props.profiles}
          cache={props.cache}
          presignEnabled={props.presignEnabled}
        />
      ))}
    </ul>
  );
}

/** The thread pane: header (+ optional back), message list, and composer. */
export function MessageThread(props: MessageThreadProps): ReactElement {
  const { canAttach, presignEnabled, presignCache, uploadFile } = useChatAttachments();
  return (
    <div className="flex h-full flex-col bg-panel">
      <div className="flex items-center gap-2 border-b border-border px-2 md:px-4 h-14">
        {props.onBack !== undefined ? (
          <IconButton label="Back to conversations" onClick={props.onBack}>
            <IconChevronRight size={20} className="rotate-180" />
          </IconButton>
        ) : null}
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-sm font-semibold text-fg',
            props.onBack === undefined && 'px-2',
          )}
        >
          {props.title}
        </span>
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
      />
      <TypingIndicator ids={props.typingUserIds} profiles={props.profiles} />
      <Composer
        onSend={props.onSend}
        disabled={!props.canSend || props.sending}
        onTyping={props.onTyping}
        {...(canAttach ? { uploadFile } : {})}
      />
    </div>
  );
}
