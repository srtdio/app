import type { ReactElement } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconChat } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import type { ChannelSummary } from '@/lib/chat-reads';

interface ChannelListProps {
  channels: ChannelSummary[];
  selectedChannelId: string | null;
  onSelect: (channel: ChannelSummary) => void;
}

/**
 * The channel list body. Pure and exported so the zero-channels case is unit
 * tested: with no channels it returns the empty state, and that empty state has
 * no action (the "New chat" action lands in a later PR, so no dead button here).
 */
export function channelListView(props: ChannelListProps): ReactElement {
  if (props.channels.length === 0) {
    return (
      <EmptyState
        icon={<IconChat size={24} />}
        title="No conversations yet"
        description="Messages from your team will show up here."
      />
    );
  }
  return (
    <ul className="flex flex-col">
      {props.channels.map((channel) => (
        <li key={channel.channelId}>
          <ChannelRow
            channel={channel}
            selected={channel.channelId === props.selectedChannelId}
            onSelect={props.onSelect}
          />
        </li>
      ))}
    </ul>
  );
}

function ChannelRow(props: {
  channel: ChannelSummary;
  selected: boolean;
  onSelect: (channel: ChannelSummary) => void;
}): ReactElement {
  const { channel } = props;
  return (
    <button
      type="button"
      onClick={() => props.onSelect(channel)}
      className={cn(
        'flex w-full items-center gap-3 px-4 min-h-[56px] text-left transition-colors',
        props.selected ? 'bg-panel-2 text-fg' : 'text-fg-2 hover:bg-panel-2',
      )}
    >
      <Avatar
        name={channel.title}
        {...(channel.avatarUrl !== null ? { src: channel.avatarUrl } : {})}
        size="lg"
      />
      <span className="truncate text-sm font-medium">{channel.title}</span>
    </button>
  );
}

/** Scrollable channel list pane. */
export function ChannelList(props: ChannelListProps): ReactElement {
  return <div className="h-full overflow-y-auto">{channelListView(props)}</div>;
}
