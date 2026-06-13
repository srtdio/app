import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { isValidElement } from 'react';
import { ChannelList } from '@/components/chat/ChannelList';
import { EmptyState } from '@/components/ui/EmptyState';
import type { ChannelSummary } from '@/lib/chat-reads';

function flatten(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(flatten);
  if (!isValidElement(node)) return [];
  const children = (node.props as { children?: ReactNode }).children;
  return [node, ...flatten(children)];
}

function summary(channelId: string, title: string): ChannelSummary {
  return {
    channel: {
      agora_group_id: 'g',
      channel_id: channelId,
      channel_type: 'group',
      created_at: '2026-06-01T00:00:00Z',
      dm_user_a: null,
      dm_user_b: null,
      entity_id: 'grp',
      last_synced_at: null,
      workspace_id: 'ws-1',
    },
    kind: 'group',
    title,
    avatarUrl: null,
  };
}

describe('ChannelList', () => {
  it('renders the empty state with no action when there are no channels', () => {
    const element = ChannelList({ channels: [], selectedId: null, onSelect: vi.fn() });
    expect(element.type).toBe(EmptyState);
    expect((element.props as { action?: unknown }).action).toBeUndefined();
  });

  it('renders one selectable row per channel', () => {
    const onSelect = vi.fn();
    const element = ChannelList({
      channels: [summary('c1', 'Design'), summary('c2', 'Growth')],
      selectedId: null,
      onSelect,
    });
    const buttons = flatten(element).filter((el) => el.type === 'button');
    expect(buttons).toHaveLength(2);

    (buttons[1]?.props as { onClick: () => void }).onClick();
    expect(onSelect).toHaveBeenCalledWith('c2');
  });
});
