import { useState } from 'react';
import type { ReactElement } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { SectionHeader } from '@/components/shell/SectionHeader';
import { IconChat, IconPlus } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { filterChannelsByName } from '@/lib/channel-filter';
import type { ChannelSummary } from '@/lib/chat-reads';

interface ChannelListProps {
  channels: ChannelSummary[];
  selectedChannelId: string | null;
  onSelect: (channel: ChannelSummary) => void;
  /** Opens the New chat sheet (header "+" and empty-state action). */
  onNewChat: () => void;
}

interface ChannelListBodyProps extends ChannelListProps {
  /** Whether any conversations exist before the search filter is applied. */
  hasChannels: boolean;
}

/**
 * The channel list body. Pure and exported so its three states are unit tested:
 * the zero-state when no conversations exist (with a real "New chat" action), a
 * distinct "No matches" state when a search hides every conversation, and one row
 * per channel otherwise.
 */
export function channelListView(props: ChannelListBodyProps): ReactElement {
  if (!props.hasChannels) {
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
  if (props.channels.length === 0) {
    return (
      <div className="px-4 py-12 text-center">
        <p className="text-sm text-fg-2">No matches</p>
        <p className="mt-1 text-xs text-fg-3">Try a different name or clear the search.</p>
      </div>
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

interface ChannelListContentProps extends ChannelListProps {
  search: string;
  onSearchChange: (value: string) => void;
}

/**
 * The full channel list pane: the shared SectionHeader (controlled name search +
 * accent "+" New chat, no sort, no chips) above the filtered body. Pure (no
 * hooks) so the search wiring and the single-header guarantee are unit tested by
 * walking the returned tree; ChannelList owns the search state.
 */
export function channelListContent(props: ChannelListContentProps): ReactElement {
  const filtered = filterChannelsByName(props.channels, props.search);
  return (
    <div className="flex h-full flex-col">
      <SectionHeader
        search={{
          value: props.search,
          onChange: props.onSearchChange,
          placeholder: 'Search conversations',
        }}
        primaryAction={{
          node: (
            <Button
              variant="primary"
              size="lg"
              aria-label="New chat"
              className="w-11 px-0"
              onClick={props.onNewChat}
            >
              <IconPlus size={18} />
            </Button>
          ),
        }}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {channelListView({
          channels: filtered,
          hasChannels: props.channels.length > 0,
          selectedChannelId: props.selectedChannelId,
          onSelect: props.onSelect,
          onNewChat: props.onNewChat,
        })}
      </div>
    </div>
  );
}

/** Scrollable channel list pane with the shared search/create header. */
export function ChannelList(props: ChannelListProps): ReactElement {
  const [search, setSearch] = useState('');
  return channelListContent({ ...props, search, onSearchChange: setSearch });
}
