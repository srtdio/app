import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { channelListContent, channelListView } from '@/components/chat/ChannelList';
import { SectionHeader } from '@/components/shell/SectionHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import type { ChannelSummary } from '@/lib/chat-reads';

function summary(over: Partial<ChannelSummary>): ChannelSummary {
  return {
    channelId: 'c1',
    channelType: 'group',
    title: 'Team',
    avatarUrl: null,
    agoraGroupId: 'ag1',
    groupId: 'g1',
    peerUserId: null,
    createdAt: 't',
    ...over,
  };
}

// channelListContent/channelListView are pure (no hooks), so they are called as
// functions and their element tree walked without a DOM, mirroring the
// SectionHeader/SortMenu test style in this codebase.
function isElement(node: ReactNode): node is ReactElement {
  return typeof node === 'object' && node !== null && 'props' in node;
}

// SectionHeader is hookless and holds search/primaryAction in props, so it is
// expanded by calling its render once (mirroring SectionHeader's own tests).
function expandSectionHeader(el: ReactElement): ReactElement {
  return (el.type as unknown as (props: unknown) => ReactElement)(el.props);
}

function collect(node: ReactNode, found: ReactElement[]): void {
  if (Array.isArray(node)) {
    node.forEach((child) => collect(child, found));
    return;
  }
  if (!isElement(node)) return;
  found.push(node);
  if (node.type === SectionHeader) {
    collect(expandSectionHeader(node), found);
    return;
  }
  collect((node.props as { children?: ReactNode }).children, found);
}

function findAll(tree: ReactNode, predicate: (el: ReactElement) => boolean): ReactElement[] {
  const all: ReactElement[] = [];
  collect(tree, all);
  return all.filter(predicate);
}

function texts(tree: ReactNode): string[] {
  const out: string[] = [];
  const all: ReactElement[] = [];
  collect(tree, all);
  for (const el of all) {
    const child = (el.props as { children?: ReactNode }).children;
    if (typeof child === 'string') out.push(child);
  }
  return out;
}

function ariaLabel(el: ReactElement): string | undefined {
  return (el.props as { 'aria-label'?: string })['aria-label'];
}

function content(over: {
  channels: ChannelSummary[];
  search?: string;
  onNewChat?: () => void;
  onSearchChange?: (value: string) => void;
}): ReactElement {
  return channelListContent({
    channels: over.channels,
    selectedChannelId: null,
    onSelect: () => {},
    onNewChat: over.onNewChat ?? (() => {}),
    search: over.search ?? '',
    onSearchChange: over.onSearchChange ?? (() => {}),
  });
}

describe('channelListView', () => {
  it('renders the zero-state with a New chat action when no conversations exist', () => {
    const view = channelListView({
      channels: [],
      hasChannels: false,
      selectedChannelId: null,
      onSelect: () => {},
      onNewChat: () => {},
    });
    expect(view.type).toBe(EmptyState);
    const props = view.props as { title: string; action?: unknown };
    expect(props.title).toBe('No conversations yet');
    expect(props.action).toBeDefined();
  });

  it('renders a distinct No matches state, not the zero-state, when search hides all', () => {
    const view = channelListView({
      channels: [],
      hasChannels: true,
      selectedChannelId: null,
      onSelect: () => {},
      onNewChat: () => {},
    });
    expect(view.type).not.toBe(EmptyState);
    expect(texts(view)).toContain('No matches');
  });

  it('renders one row per channel when there are matches', () => {
    const view = channelListView({
      channels: [summary({ channelId: 'a' }), summary({ channelId: 'b' })],
      hasChannels: true,
      selectedChannelId: 'a',
      onSelect: () => {},
      onNewChat: () => {},
    });
    expect(view.type).toBe('ul');
    const children = (view.props as { children: ReactElement[] }).children;
    expect(children).toHaveLength(2);
  });
});

describe('channelListContent', () => {
  const channels = [
    summary({ channelId: 'a', title: 'Design team' }),
    summary({ channelId: 'b', title: 'Client Acme' }),
  ];

  it('filters the conversation list by name and restores all on empty query', () => {
    const lists = findAll(content({ channels, search: 'acme' }), (el) => el.type === 'ul');
    expect((lists[0]!.props as { children: ReactElement[] }).children).toHaveLength(1);

    const allLists = findAll(content({ channels, search: '' }), (el) => el.type === 'ul');
    expect((allLists[0]!.props as { children: ReactElement[] }).children).toHaveLength(2);
  });

  it('shows No matches (not the zero-state) when a search matches nothing', () => {
    const tree = content({ channels, search: 'zzz' });
    expect(findAll(tree, (el) => el.type === EmptyState)).toHaveLength(0);
    expect(texts(tree)).toContain('No matches');
  });

  it('still shows the zero-state with New chat when there are no channels', () => {
    const tree = content({ channels: [], search: '' });
    const empties = findAll(tree, (el) => el.type === EmptyState);
    expect(empties).toHaveLength(1);
    expect((empties[0]!.props as { title: string }).title).toBe('No conversations yet');
  });

  it('fires onNewChat from the header "+" action', () => {
    const onNewChat = vi.fn();
    const tree = content({ channels, onNewChat });
    const buttons = findAll(tree, (el) => ariaLabel(el) === 'New chat');
    expect(buttons).toHaveLength(1);
    (buttons[0]!.props as { onClick: () => void }).onClick();
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });

  it('renders exactly one header and no "Chat" title text', () => {
    const tree = content({ channels });
    expect(findAll(tree, (el) => el.type === SectionHeader)).toHaveLength(1);
    expect(findAll(tree, (el) => el.type === 'h2')).toHaveLength(0);
    expect(texts(tree)).not.toContain('Chat');
  });
});
