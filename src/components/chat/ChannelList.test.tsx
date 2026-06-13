import { describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { channelListView } from '@/components/chat/ChannelList';
import { EmptyState } from '@/components/ui/EmptyState';
import type { ChannelSummary } from '@/lib/chat-reads';

function summary(over: Partial<ChannelSummary>): ChannelSummary {
  return {
    channelId: 'c1',
    channelType: 'group',
    title: 'Team',
    avatarUrl: null,
    agoraGroupId: 'ag1',
    peerUserId: null,
    createdAt: 't',
    ...over,
  };
}

describe('channelListView', () => {
  it('renders the empty state with no action when there are zero channels', () => {
    const view = channelListView({ channels: [], selectedChannelId: null, onSelect: () => {} });
    expect(view.type).toBe(EmptyState);
    const props = view.props as { title: string; action?: unknown };
    expect(props.title).toBe('No conversations yet');
    // The "New chat" action is PR4: no dead or disabled button here.
    expect(props.action).toBeUndefined();
  });

  it('renders one row per channel when there are channels', () => {
    const channels = [summary({ channelId: 'a' }), summary({ channelId: 'b' })];
    const view = channelListView({ channels, selectedChannelId: 'a', onSelect: () => {} });
    expect(view.type).toBe('ul');
    const children = (view.props as { children: ReactElement[] }).children;
    expect(children).toHaveLength(2);
  });
});
