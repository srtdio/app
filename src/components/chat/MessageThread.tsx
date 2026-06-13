import type { ReactElement } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { IconButton } from '@/components/ui/IconButton';
import { IconChat, IconChevronRight } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import type { ChatProfile } from '@/lib/chat-reads';
import type { ThreadMessage } from '@/lib/chat/thread';
import { Composer } from '@/components/chat/Composer';

interface MessageThreadProps {
  title: string;
  /** Sender display info keyed by Sorted user id; batched read, never per-row. */
  profiles: Map<string, ChatProfile>;
  messages: ThreadMessage[];
  loading: boolean;
  sending: boolean;
  /** False when the channel has no Agora target yet (e.g. group not synced). */
  canSend: boolean;
  onSend: (text: string) => Promise<void>;
  /** Present on small screens only; renders a back affordance to the list. */
  onBack?: () => void;
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
}): ReactElement {
  const { message, profiles } = props;
  const name = senderName(message, profiles);
  return (
    <li className="flex gap-3 px-4 py-2">
      <Avatar name={name} {...senderAvatarProps(message, profiles)} size="md" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium text-fg">{name}</span>
          <span className="text-xs text-fg-3">{formatTime(message.time)}</span>
        </div>
        <p className="whitespace-pre-wrap break-words text-sm text-fg-2">{message.body}</p>
      </div>
    </li>
  );
}

function ThreadBody(
  props: Pick<MessageThreadProps, 'messages' | 'loading' | 'profiles'>,
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
        <MessageBubble key={message.id} message={message} profiles={props.profiles} />
      ))}
    </ul>
  );
}

/** The thread pane: header (+ optional back), message list, and composer. */
export function MessageThread(props: MessageThreadProps): ReactElement {
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
            'truncate text-sm font-semibold text-fg',
            props.onBack === undefined && 'px-2',
          )}
        >
          {props.title}
        </span>
      </div>
      <ThreadBody messages={props.messages} loading={props.loading} profiles={props.profiles} />
      <Composer onSend={props.onSend} disabled={!props.canSend || props.sending} />
    </div>
  );
}
