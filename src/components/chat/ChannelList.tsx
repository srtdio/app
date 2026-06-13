import { Avatar } from '@/components/ui/Avatar';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconChat } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import type { ChannelSummary } from '@/lib/chat-reads';

interface ChannelListProps {
  channels: ChannelSummary[];
  selectedId: string | null;
  onSelect: (channelId: string) => void;
}

/**
 * The conversation list. Pure and hook-free. With no channels it shows the empty
 * state with no action (starting a new chat lands in a later PR), so there is no
 * dead button. Each row is a >=44px touch target.
 */
export function ChannelList({ channels, selectedId, onSelect }: ChannelListProps) {
  if (channels.length === 0) {
    return (
      <EmptyState
        icon={<IconChat size={24} />}
        title="No conversations yet"
        description="Conversations you are part of will show up here."
      />
    );
  }

  return (
    <ul className="flex flex-col">
      {channels.map((summary) => {
        const id = summary.channel.channel_id;
        const active = id === selectedId;
        return (
          <li key={id}>
            <button
              type="button"
              onClick={() => onSelect(id)}
              className={cn(
                'flex w-full items-center gap-3 px-3 min-h-[56px] text-left transition-colors',
                active ? 'bg-panel-2 text-fg' : 'text-fg-2 hover:bg-panel-2',
              )}
            >
              <Avatar
                name={summary.title}
                size="lg"
                {...(summary.avatarUrl !== null ? { src: summary.avatarUrl } : {})}
              />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{summary.title}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
