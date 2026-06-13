import { useState } from 'react';
import { PageHead } from '@/components/shell/PageHead';
import { useChat } from '@/lib/chat';
import { useSession } from '@/lib/session-context';
import { useWorkspace } from '@/lib/workspace-context';
import { cn } from '@/lib/cn';
import { ChannelList } from '@/components/chat/ChannelList';
import { ChatNotice } from '@/components/chat/ChatNotice';
import { MessageThread } from '@/components/chat/MessageThread';
import { useChatChannels } from '@/lib/chat/use-chat-channels';
import { channelTarget, type ThreadConnection } from '@/lib/chat/thread';

/**
 * The chat surface. Renders the Foundation connection status: a loading notice
 * while connecting, an unavailable panel on failure (the rest of the app is
 * unaffected), and the master-detail shell once connected.
 */
export function ChatShell() {
  const { status, client } = useChat();
  return (
    <>
      <PageHead title="Chat" />
      {status === 'connected' && client !== null ? (
        <ChatWorkspace client={client as ThreadConnection} />
      ) : (
        <ChatNotice variant={status === 'connecting' ? 'loading' : 'unavailable'} />
      )}
    </>
  );
}

function ChatWorkspace({ client }: { client: ThreadConnection }) {
  const { session } = useSession();
  const { workspaceId } = useWorkspace();
  const currentUserId = session?.user.id ?? null;
  const { summaries } = useChatChannels({ workspaceId, currentUserId });
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selected = summaries.find((s) => s.channel.channel_id === selectedId) ?? null;
  const target =
    selected !== null && currentUserId !== null
      ? channelTarget(selected.channel, currentUserId)
      : null;

  return (
    <div className="flex h-full min-h-0">
      <div
        className={cn(
          'w-full flex-col border-r border-border overflow-y-auto md:flex md:w-80',
          selected !== null ? 'hidden' : 'flex',
        )}
      >
        <ChannelList channels={summaries} selectedId={selectedId} onSelect={setSelectedId} />
      </div>
      <div className={cn('flex-1 min-w-0 md:flex', selected !== null ? 'flex' : 'hidden')}>
        {selected !== null && currentUserId !== null ? (
          <MessageThread
            client={client}
            title={selected.title}
            target={target}
            currentUserId={currentUserId}
            onBack={() => setSelectedId(null)}
          />
        ) : (
          <div className="hidden md:flex flex-1 items-center justify-center text-fg-3 text-sm">
            Select a conversation
          </div>
        )}
      </div>
    </div>
  );
}
