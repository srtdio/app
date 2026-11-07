import { describe, expect, it, vi } from 'vitest';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import type { ReactElement, ReactNode } from 'react';

// ChannelList now consumes the chat store, whose provider import graph pulls the
// real agora-chat browser SDK. Mock it so importing the (hookless) view helpers
// in node never touches browser globals, mirroring ChatShell.test.tsx.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import {
  ChannelCard,
  chatSelectActions,
  channelListContent,
  channelListView,
  draftLine,
  notesLastLine,
  previewLine,
  showSearchResults,
  visibleChannels,
  type ChannelSelectMode,
} from '@/components/chat/ChannelList';
import { SectionHeader } from '@/components/shell/SectionHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { NoResults } from '@/components/ui/NoResults';
import { IconEyeOff, IconPlus } from '@/components/ui/icons';
import { ListCardBox, type ListCardSelect } from '@/components/ui/ListCard';
import type { ChannelSummary } from '@/lib/chat-reads';
import { renderToStaticMarkup } from 'react-dom/server';

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

function isSelectButton(el: ReactElement): boolean {
  return el.type === IconButton && (el.props as { label?: string }).label === 'Select';
}

function isNewChat(el: ReactElement): boolean {
  const children = (el.props as { children?: ReactNode }).children;
  return Array.isArray(children) && children.includes('New chat');
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
    status: 'ready',
    onRetry: () => {},
    onSelect: () => {},
    onNewChat: over.onNewChat ?? (() => {}),
    search: over.search ?? '',
    onSearchChange: over.onSearchChange ?? (() => {}),
  });
}

describe('channelListView', () => {
  it('renders the zero-state with no create button of its own (the header has New chat)', () => {
    const view = channelListView({
      channels: [],
      hasChannels: false,
      selectedChannelId: null,
      onSelect: () => {},
      onNewChat: () => {},
    });
    expect(view.type).toBe(EmptyState);
    const props = view.props as { title: string; action?: unknown };
    expect(props.title).toBe('Chats with your team show up here.');
    expect(props.action).toBeUndefined();
  });

  it('renders NoResults, not the zero-state, when search hides all', () => {
    const view = channelListView({
      channels: [],
      hasChannels: true,
      search: ' zzz ',
      selectedChannelId: null,
      onSelect: () => {},
      onNewChat: () => {},
    });
    expect(view.type).not.toBe(EmptyState);
    expect(view.type).toBe(NoResults);
    expect((view.props as { query: string; filtersActive: boolean }).query).toBe(' zzz ');
    expect((view.props as { query: string; filtersActive: boolean }).filtersActive).toBe(false);
  });

  it('renders one row per channel when there are matches', () => {
    const view = channelListView({
      channels: [summary({ channelId: 'a' }), summary({ channelId: 'b' })],
      hasChannels: true,
      selectedChannelId: 'a',
      onSelect: () => {},
      onNewChat: () => {},
    });
    const lists = findAll(view, (el) => el.type === 'ul');
    expect(lists).toHaveLength(1);
    expect((lists[0]!.props as { children: ReactElement[] }).children).toHaveLength(2);
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

  it('names the query (not the zero-state) when a search matches nothing', () => {
    const tree = content({ channels, search: 'zzz' });
    expect(findAll(tree, (el) => el.type === EmptyState)).toHaveLength(0);
    const none = findAll(tree, (el) => el.type === NoResults);
    expect(none).toHaveLength(1);
    expect((none[0]!.props as { query: string }).query).toBe('zzz');
  });

  it('still shows the zero-state with New chat when there are no channels', () => {
    const tree = content({ channels: [], search: '' });
    const empties = findAll(tree, (el) => el.type === EmptyState);
    expect(empties).toHaveLength(1);
    expect((empties[0]!.props as { title: string }).title).toBe(
      'Chats with your team show up here.',
    );
  });

  it('fires onNewChat from the header New chat text button', () => {
    const onNewChat = vi.fn();
    const tree = content({ channels, onNewChat });
    const buttons = findAll(tree, isNewChat);
    expect(buttons).toHaveLength(1);
    (buttons[0]!.props as { onClick: () => void }).onClick();
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });

  it('shows New chat as visible text with IconPlus before it, not an icon-only button', () => {
    const tree = content({ channels });
    const button = findAll(tree, isNewChat)[0]!;
    expect(ariaLabel(button)).toBeUndefined();
    expect(findAll(tree, (el) => ariaLabel(el) === 'New chat')).toHaveLength(0);
    const children = (button.props as { children: ReactNode[] }).children;
    expect((children[0] as ReactElement).type).toBe(IconPlus);
    expect(children[1]).toBe('New chat');
  });

  it('renders exactly one header and no "Chat" title text', () => {
    const tree = content({ channels });
    expect(findAll(tree, (el) => el.type === SectionHeader)).toHaveLength(1);
    expect(findAll(tree, (el) => el.type === 'h2')).toHaveLength(0);
    expect(texts(tree)).not.toContain('Chat');
  });
});

describe('hidden chats (deleted for me)', () => {
  const channels = [
    summary({ channelId: 'a', title: 'Design team' }),
    summary({ channelId: 'h', title: 'Hidden peer', channelType: 'dm' }),
  ];
  const isHidden = (id: string): boolean => id === 'h';
  const none = (): undefined => undefined;

  it('leaves a hidden chat out of the plain list', () => {
    expect(visibleChannels(channels, none, isHidden, '').map((c) => c.channelId)).toEqual(['a']);
  });

  it('search still finds a hidden chat', () => {
    expect(visibleChannels(channels, none, isHidden, 'hidden').map((c) => c.channelId)).toEqual([
      'h',
    ]);
  });

  it('renders only the visible rows and the zero-state when every chat is hidden', () => {
    const tree = channelListContent({
      channels,
      selectedChannelId: null,
      status: 'ready',
      onRetry: () => {},
      onSelect: () => {},
      onNewChat: () => {},
      search: '',
      onSearchChange: () => {},
      isHidden,
    });
    const lists = findAll(tree, (el) => el.type === 'ul');
    expect((lists[0]!.props as { children: ReactElement[] }).children).toHaveLength(1);

    const allHidden = channelListContent({
      channels,
      selectedChannelId: null,
      status: 'ready',
      onRetry: () => {},
      onSelect: () => {},
      onNewChat: () => {},
      search: '',
      onSearchChange: () => {},
      isHidden: () => true,
    });
    expect(findAll(allHidden, (el) => el.type === EmptyState)).toHaveLength(1);
  });
});

describe('select mode', () => {
  const channels = [
    summary({ channelId: 'a', title: 'Design team' }),
    summary({ channelId: 'b', title: 'Client Acme' }),
  ];

  function select(over: Partial<ChannelSelectMode>): ChannelSelectMode {
    return {
      active: false,
      selectedIds: new Set(),
      onEnter: vi.fn(),
      onStart: vi.fn(),
      onCancel: vi.fn(),
      onToggle: vi.fn(),
      onDelete: vi.fn(),
      ...over,
    };
  }

  function tree(mode: ChannelSelectMode, kind: 'photo' | null = null): ReactElement {
    return channelListContent({
      channels,
      selectedChannelId: null,
      status: 'ready',
      onRetry: () => {},
      onSelect: () => {},
      onNewChat: () => {},
      search: '',
      onSearchChange: () => {},
      select: mode,
      kind,
      onKindChange: () => {},
    });
  }

  function barOf(t: ReactElement): ReactElement | undefined {
    return findAll(
      t,
      (el) => (el.props as Record<string, unknown>)['data-chat-select-bar'] !== undefined,
    )[0];
  }

  function actionsOf(t: ReactElement): ReactElement[] {
    return findAll(barOf(t), (el) => el.type === IconButton);
  }

  it('no header Select on the chat list: a long-press or right-click on a card enters', () => {
    const mode = select({});
    const t = tree(mode);
    expect(findAll(t, isSelectButton)).toHaveLength(0);
    expect(findAll(t, isNewChat)).toHaveLength(1);
    expect(barOf(t)).toBeUndefined();
    // Every chat card carries ListCard's select, off, entering with that chat ticked.
    const cards = findAll(t, (el) => el.type === ChannelCard);
    const selects = cards.map((c) => (c.props as { select?: ListCardSelect }).select);
    expect(selects.map((s) => s?.active)).toEqual([false, false]);
    selects[1]!.onEnter();
    expect(mode.onEnter).toHaveBeenCalledWith('b');
  });

  it('a chip view keeps the header Select (media items have no long-press)', () => {
    const mode = select({});
    const button = findAll(tree(mode, 'photo'), isSelectButton)[0];
    expect(button).toBeDefined();
    (button!.props as { onClick: () => void }).onClick();
    expect(mode.onStart).toHaveBeenCalledTimes(1);
  });

  it('in select mode the header stays, cards tick and taps toggle', () => {
    const mode = select({ active: true, selectedIds: new Set(['b']) });
    const t = tree(mode);
    expect(findAll(t, (el) => el.type === SectionHeader)).toHaveLength(1);
    expect(findAll(t, isSelectButton)).toHaveLength(0);
    const cards = findAll(t, (el) => el.type === ChannelCard);
    const selects = cards.map((c) => (c.props as { select: ListCardSelect }).select);
    expect(selects.map((s) => s.active)).toEqual([true, true]);
    expect(selects.map((s) => s.chosen)).toEqual([false, true]);
    selects[0]!.onToggle();
    expect(mode.onToggle).toHaveBeenCalledWith('a');
  });

  it('the bar: Cancel, "N selected", Hide chat (any count, eye-off, never red)', () => {
    const some = select({ active: true, selectedIds: new Set(['a', 'b']) });
    const t = tree(some);
    expect(texts(barOf(t))).toContain('2 selected');
    const cancel = findAll(
      barOf(t),
      (el) => (el.props as Record<string, unknown>)['data-selection-cancel'] !== undefined,
    )[0]!;
    (cancel.props as { onClick: () => void }).onClick();
    expect(some.onCancel).toHaveBeenCalledTimes(1);
    const actions = actionsOf(t);
    expect(actions.map((a) => (a.props as { label: string }).label)).toEqual(['Hide chat']);
    const hide = actions[0]!.props as Record<string, unknown>;
    expect(hide['data-selection-hide']).toBe('');
    expect(hide.disabled).toBe(false);
    expect(hide.className).toBeUndefined();
    (hide.onClick as () => void)();
    expect(some.onDelete).toHaveBeenCalledTimes(1);
    expect(chatSelectActions(some)[0]!.icon).toBe(IconEyeOff);
    // Never a confirm: the hide runs behind the Undo toast.
    expect(texts(t)).not.toContain('Hide chats?');
  });

  it('a chip view selects items: Forward and Delete for me, never Hide, both disabled at 0', () => {
    const onForward = vi.fn();
    const empty = select({ active: true, media: { onForward } });
    const bar = barOf(tree(empty));
    expect((bar!.props as Record<string, unknown>)['data-testid']).toBe('media-select-bar');
    expect(texts(bar)).toContain('0 selected');
    const emptyActions = actionsOf(tree(empty));
    expect(emptyActions).toHaveLength(2);
    for (const b of emptyActions) expect((b.props as { disabled: boolean }).disabled).toBe(true);

    const some = select({ active: true, selectedIds: new Set(['m1']), media: { onForward } });
    const [forward, del] = actionsOf(tree(some));
    const forwardProps = forward?.props as Record<string, unknown>;
    const deleteProps = del?.props as Record<string, unknown>;
    expect(forwardProps['data-selection-forward']).toBe('');
    expect(deleteProps['data-selection-delete']).toBe('');
    expect(deleteProps.label).toBe('Delete for me');
    expect(deleteProps.className).toContain('text-bad');
    expect(forwardProps.disabled).toBe(false);
    expect(deleteProps.disabled).toBe(false);
    (forwardProps.onClick as () => void)();
    (deleteProps.onClick as () => void)();
    expect(onForward).toHaveBeenCalledTimes(1);
    expect(some.onDelete).toHaveBeenCalledTimes(1);
  });

  it('a chip view with no forward path shows Delete for me only', () => {
    const mode = select({ active: true, selectedIds: new Set(['m1']), media: {} });
    const actions = actionsOf(tree(mode));
    expect(actions).toHaveLength(1);
    expect((actions[0]?.props as { label?: string }).label).toBe('Delete for me');
  });

  it('New chat leaves select mode', () => {
    const mode = select({ active: true, selectedIds: new Set(['a']) });
    (findAll(tree(mode), isNewChat)[0]!.props as { onClick: () => void }).onClick();
    expect(mode.onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('load status', () => {
  const channels = [summary({ channelId: 'a', title: 'Design team' })];

  function withStatus(status: 'loading' | 'error', onRetry: () => void = () => {}): ReactElement {
    return channelListContent({
      channels,
      status,
      onRetry,
      selectedChannelId: null,
      onSelect: () => {},
      onNewChat: () => {},
      search: '',
      onSearchChange: () => {},
      select: {
        active: false,
        selectedIds: new Set(),
        onEnter: () => {},
        onStart: () => {},
        onCancel: () => {},
        onToggle: () => {},
        onDelete: () => {},
      },
    });
  }

  it('loading renders skeleton rows, never the empty state, rows or Select', () => {
    const tree = withStatus('loading');
    const skeletons = findAll(
      tree,
      (el) => (el.props as Record<string, unknown>)['data-skeleton-row'] !== undefined,
    );
    expect(skeletons.length).toBeGreaterThan(0);
    expect(findAll(tree, (el) => el.type === EmptyState)).toHaveLength(0);
    expect(findAll(tree, (el) => el.type === ChannelCard)).toHaveLength(0);
    expect(findAll(tree, isSelectButton)).toHaveLength(0);
    expect(texts(tree)).not.toContain('Chats with your team show up here.');
  });

  it('skeleton shapes are the real part (6 round cards, one list): ListCardBox', () => {
    const shells = findAll(
      withStatus('loading'),
      (el) => (el.props as Record<string, unknown>)['data-skeleton-row'] !== undefined,
    );
    const kinds = shells.map((t) => (t.props as Record<string, unknown>)['data-skeleton-row']);
    expect(kinds).toEqual(['card', 'card', 'card', 'card', 'card', 'card']);
    const boxes = shells.map((shell) => findAll(shell, (el) => el.type === ListCardBox));
    for (const box of boxes) expect(box).toHaveLength(1);
    // One list, no sections: six round boxes.
    expect(boxes.map((b) => (b[0]!.props as { round?: boolean }).round === true)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    // Boxes sweep (motion Bone, in the card's slots); never a pulse, fade or spinner.
    const html = renderToStaticMarkup(<ListCardBox />);
    expect(html).toContain('data-list-card-box=""');
    expect(html).toContain('h-12 w-12');
    expect(html).not.toContain('animate-pulse');
    expect(
      findAll(withStatus('loading'), (el) =>
        /animate-spin|mv-spin/.test((el.props as { className?: string }).className ?? ''),
      ),
    ).toHaveLength(0);
  });

  it('error renders Retry (44px tall) and no rows or Select', () => {
    const onRetry = vi.fn();
    const tree = withStatus('error', onRetry);
    expect(findAll(tree, (el) => el.type === ChannelCard)).toHaveLength(0);
    expect(findAll(tree, isSelectButton)).toHaveLength(0);
    const empty = findAll(tree, (el) => el.type === EmptyState)[0]!;
    const retry = (empty.props as { action: ReactElement }).action;
    // A Button: 44 tall by the design system.
    expect(retry.type).toBe(Button);
    expect(retry.props).toMatchObject({ variant: 'primary', children: 'Retry' });
    (retry.props as { onClick: () => void }).onClick();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('message search wiring (S1)', () => {
  const channels = [
    summary({ channelId: 'g1', title: 'Shoot crew' }),
    summary({ channelId: 'g2', title: 'Accounts' }),
  ];
  const results = <div data-testid-results="">results</div>;
  const content = (search: string) =>
    channelListContent({
      channels,
      selectedChannelId: null,
      status: 'ready',
      onRetry: () => {},
      onSelect: () => {},
      onNewChat: () => {},
      search,
      onSearchChange: () => {},
      searchResults: results,
    });

  it('shows results only from 2 trimmed characters', () => {
    expect(showSearchResults('')).toBe(false);
    expect(showSearchResults(' s ')).toBe(false);
    expect(showSearchResults('sh')).toBe(true);
  });

  it('2+ characters replace the list with the results (no old list under them)', () => {
    const tree = content('sh');
    expect(findAll(tree, (el) => el === results)).toHaveLength(1);
    expect(findAll(tree, (el) => el.props['data-chat-home'] === '')).toHaveLength(0);
  });

  it('under 2 characters keeps the name filter only', () => {
    const tree = content('a');
    expect(findAll(tree, (el) => el === results)).toHaveLength(0);
    const titles = findAll(tree, (el) => el.type === ChannelCard).map(
      (el) => (el.props as { channel: ChannelSummary }).channel.title,
    );
    expect(titles).toEqual(['Accounts']);
  });

  it('clearing restores the list exactly as before', () => {
    const before = findAll(content(''), (el) => el.type === ChannelCard).map(
      (el) => (el.props as { channel: ChannelSummary }).channel.channelId,
    );
    content('shoot');
    const after = findAll(content(''), (el) => el.type === ChannelCard).map(
      (el) => (el.props as { channel: ChannelSummary }).channel.channelId,
    );
    expect(after).toEqual(before);
  });

  it('the SectionHeader search box is untouched (one header, "Search chats")', () => {
    const headers = findAll(content('sh'), (el) => el.type === SectionHeader);
    expect(headers).toHaveLength(1);
    expect((headers[0]!.props as { search: { placeholder: string } }).search.placeholder).toBe(
      'Search chats',
    );
  });
});

describe('chat list lines hide formatting markers', () => {
  const line = (text: string, prefix?: string) =>
    previewLine({
      lastMessageText: text,
      ...(prefix !== undefined ? { lastMessagePrefix: prefix } : {}),
      lastMessageTs: 1,
      unread: 0,
    });

  it('the preview line reads the words without markers, after the sender prefix', () => {
    expect(line('*ship* _today_')).toBe('ship today');
    expect(line('~old~ +new+ ```code```', 'You')).toBe('You: old new code');
  });

  it('mid-word and unmatched markers stay as typed', () => {
    expect(line('snake_case_name')).toBe('snake_case_name');
    expect(line('2*3 is *six')).toBe('2*3 is *six');
  });

  it('the notes tile line and a draft line hide markers too', () => {
    const notes = notesLastLine(
      { lastMessageText: '*ship* _today_', lastMessageTs: 1, unread: 0 },
      1,
    );
    expect(notes?.preview).toBe('ship today');
    expect(draftLine('*ship* _today_', 'w1')).toBe('ship today');
    expect(draftLine('snake_case_name', 'w1')).toBe('snake_case_name');
  });
});

describe('chat list time: formatAgo on the list clock', () => {
  it('the notes tile reads how long ago its last note landed', () => {
    const now = Date.parse('2026-11-07T12:00:00Z');
    const at = (ago: number) =>
      notesLastLine({ lastMessageText: 'Buy film', lastMessageTs: now - ago, unread: 0 }, now)
        ?.time;
    expect(at(20_000)).toBe('just now');
    expect(at(5 * 60_000)).toBe('5m');
    expect(at(3 * 3_600_000)).toBe('3h');
    // Noon UTC on both sides: the same civil gap in any zone. Sat 7 Nov -> Thu.
    expect(at(86_400_000)).toBe('Yesterday');
    expect(at(2 * 86_400_000)).toBe('Thu');
    expect(at(8 * 86_400_000)).toBe('30 Oct');
  });
});
