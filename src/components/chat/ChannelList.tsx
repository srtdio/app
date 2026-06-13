import type { ReactElement } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconButton } from '@/components/ui/IconButton';
import { IconChat, IconPlus } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import type { ChannelSummary } from '@/lib/chat-reads';

interface ChannelListProps {
  channels: ChannelSummary[];
  selectedChannelId: string | null;
  onSelect: (channel: ChannelSummary) => void;
  /** Opens the New chat sheet (list header and empty-state action). */
  onNewChat: () => void;
}

/**
 * The channel list body. Pure and exported so the zero-channels case is unit
 * tested: with no channels it returns the empty state, which now carries a real
 * "New chat" action that opens the New chat sheet.
 */
export function channelListView(props: ChannelListProps): ReactElement {
  if (props.channels.length === 0) {
    return (
      <EmptyState
        icon={<IconChat size={24} />}
        title="No conversations yet"
        description="Messages from your team will show up here."
        action={
          <Button size="lg" variant="primary" onClick={props.onNewChat}>
            New chat
          </Button>
        }
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

/** Scrollable channel list pane with a header carrying the New chat action. */
export function ChannelList(props: ChannelListProps): ReactElement {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-2 md:px-4 h-14">
        <span className="px-2 text-sm font-semibold text-fg">Chat</span>
        <span className="ml-auto">
          <IconButton label="New chat" onClick={props.onNewChat}>
            <IconPlus size={20} />
          </IconButton>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{channelListView(props)}</div>
    </div>
  );
}
