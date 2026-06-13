import { Avatar } from '@/components/ui/Avatar';
import { IconButton } from '@/components/ui/IconButton';
import { IconChevronRight } from '@/components/ui/icons';
import { Composer } from '@/components/chat/Composer';
import { useChatThread, type SenderProfile } from '@/lib/chat/use-chat-thread';
import type { ThreadConnection, ThreadMessage, ThreadTarget } from '@/lib/chat/thread';

interface MessageThreadProps {
  client: ThreadConnection;
  title: string;
  target: ThreadTarget | null;
  currentUserId: string;
  onBack: () => void;
}

/**
 * The live message thread for the selected channel. Reads history and live
 * messages from the Agora SDK only (never the Postgres mirror). The back
 * affordance returns to the list on small screens.
 */
export function MessageThread({
  client,
  title,
  target,
  currentUserId,
  onBack,
}: MessageThreadProps) {
  const { messages, senderFor, send } = useChatThread({ client, target, currentUserId });

  return (
    <div className="flex flex-1 flex-col min-w-0">
      <div className="flex items-center gap-1 h-14 px-3 border-b border-border">
        <IconButton label="Back to conversations" className="md:hidden" onClick={onBack}>
          <IconChevronRight className="rotate-180" size={18} />
        </IconButton>
        <span className="truncate text-sm font-semibold text-fg">{title}</span>
      </div>
      <div className="flex-1 overflow-y-auto flex flex-col gap-3 p-4">
        {messages.map((message) => (
          <MessageBubble
            key={message.id}
            message={message}
            sender={senderFor(message.senderUsername)}
          />
        ))}
      </div>
      <Composer onSend={send} />
    </div>
  );
}

function MessageBubble({
  message,
  sender,
}: {
  message: ThreadMessage;
  sender: SenderProfile | null;
}) {
  const name = sender?.displayName ?? 'Member';
  return (
    <div className="flex items-start gap-2.5">
      <Avatar name={name} size="md" {...(sender?.avatarUrl ? { src: sender.avatarUrl } : {})} />
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium text-fg truncate">{name}</span>
          <span className="text-xs text-fg-3">{formatTime(message.time)}</span>
        </div>
        <div className="text-sm text-fg-2 whitespace-pre-wrap break-words">{message.body}</div>
      </div>
    </div>
  );
}

function formatTime(time: number): string {
  return new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
