import { useCallback, useState } from 'react';
import type { ReactElement } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { SectionHeader } from '@/components/shell/SectionHeader';
import { IconChat, IconPlus } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { filterChannelsByName } from '@/lib/channel-filter';
import type { ChannelSummary } from '@/lib/chat-reads';
import { useChatStore } from '@/components/chat/ChatStoreProvider';
import { selectConversation, type ConversationSummary } from '@/lib/chat/chat-store';
import { sortChannelsByRecency } from '@/lib/chat/sort-conversations';
import { formatRelativeTime } from '@/lib/chat/format-relative-time';

/** Per-channel store lookup the cards read (preview, time, unread). */
type SummaryLookup = (channelId: string) => ConversationSummary | undefined;

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
  /** Read-only store summaries; absent in pure tests (every card reads empty). */
  summaryFor?: SummaryLookup;
  /** Clock for relative-time labels; defaults to 0 when no summary is supplied. */
  nowMs?: number;
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
  const summaryFor: SummaryLookup = props.summaryFor ?? (() => undefined);
  const nowMs = props.nowMs ?? 0;
  return (
    <ul className="flex flex-col gap-2 px-3 py-3">
      {props.channels.map((channel) => (
        <li key={channel.channelId}>
          <ChannelCard
            channel={channel}
            selected={channel.channelId === props.selectedChannelId}
            summary={summaryFor(channel.channelId)}
            nowMs={nowMs}
            onSelect={props.onSelect}
          />
        </li>
      ))}
    </ul>
  );
}

/** Build the preview line: an optional sender prefix before the last message. */
function previewLine(summary: ConversationSummary): string {
  const prefix = summary.lastMessagePrefix !== undefined ? `${summary.lastMessagePrefix}: ` : '';
  return `${prefix}${summary.lastMessageText}`;
}

/** A spaced conversation card: avatar, name + time, preview + unread pill. */
function ChannelCard(props: {
  channel: ChannelSummary;
  selected: boolean;
  summary: ConversationSummary | undefined;
  nowMs: number;
  onSelect: (channel: ChannelSummary) => void;
}): ReactElement {
  const { channel, summary } = props;
  const hasMessage = summary !== undefined && summary.lastMessageTs > 0;
  const unread = summary?.unread ?? 0;
  const isUnread = unread > 0;
  const preview = hasMessage ? previewLine(summary) : 'No messages yet';
  const time = hasMessage ? formatRelativeTime(summary.lastMessageTs, props.nowMs) : '';
  return (
    <button
      type="button"
      onClick={() => props.onSelect(channel)}
      aria-label={channel.title}
      className={cn(
        'flex w-full items-center gap-3 rounded-xl border border-l-[3px] px-3 py-3 min-h-[64px] text-left transition-colors',
        isUnread
          ? 'bg-accent-soft border-border border-l-accent'
          : props.selected
            ? 'bg-panel-2 border-border border-l-transparent'
            : 'bg-panel border-border border-l-transparent hover:bg-panel-2',
      )}
    >
      <Avatar
        name={channel.title}
        {...(channel.avatarUrl !== null ? { src: channel.avatarUrl } : {})}
        size="xl"
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-baseline gap-2">
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-sm text-fg',
              isUnread ? 'font-semibold' : 'font-medium',
            )}
          >
            {channel.title}
          </span>
          {time !== '' ? (
            <span className={cn('shrink-0 text-xs', isUnread ? 'text-accent' : 'text-fg-3')}>
              {time}
            </span>
          ) : null}
        </span>
        <span className="flex items-center gap-2">
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-xs',
              hasMessage ? 'text-fg-2' : 'italic text-fg-3',
            )}
          >
            {preview}
          </span>
          {isUnread ? (
            <span className="inline-flex h-5 min-w-[20px] shrink-0 items-center justify-center rounded-full bg-accent px-1.5 text-[11px] font-semibold leading-none text-accent-fg">
              {unread > 99 ? '99+' : unread}
            </span>
          ) : null}
        </span>
      </span>
    </button>
  );
}

interface ChannelListContentProps extends ChannelListProps {
  search: string;
  onSearchChange: (value: string) => void;
  /** Read-only store summaries; absent in pure tests (every card reads empty). */
  summaryFor?: SummaryLookup;
  /** Clock for relative-time labels, threaded to the cards. */
  nowMs?: number;
}

/**
 * The full channel list pane: the shared SectionHeader (controlled name search +
 * accent "+" New chat, no sort, no chips) above the filtered body. Pure (no
 * hooks) so the search wiring and the single-header guarantee are unit tested by
 * walking the returned tree; ChannelList owns the search state.
 */
export function channelListContent(props: ChannelListContentProps): ReactElement {
  const summaryFor: SummaryLookup = props.summaryFor ?? (() => undefined);
  const ordered = sortChannelsByRecency(props.channels, summaryFor);
  const filtered = filterChannelsByName(ordered, props.search);
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
          summaryFor,
          ...(props.nowMs !== undefined ? { nowMs: props.nowMs } : {}),
        })}
      </div>
    </div>
  );
}

/** Scrollable channel list pane with the shared search/create header. */
export function ChannelList(props: ChannelListProps): ReactElement {
  const [search, setSearch] = useState('');
  const { state } = useChatStore();
  const summaryFor = useCallback<SummaryLookup>(
    (channelId) => selectConversation(state, channelId),
    [state],
  );
  return channelListContent({
    ...props,
    search,
    onSearchChange: setSearch,
    summaryFor,
    nowMs: Date.now(),
  });
}
