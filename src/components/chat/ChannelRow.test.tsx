// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// ChannelList's import graph pulls the real agora-chat browser SDK; mock it.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, isValidElement, type ReactElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  CHAT_HOME_EDGE,
  CHAT_HOME_STACK,
  ChannelCard,
  DEFAULT_LIST_INPUT,
  CHAT_ROW_LIST,
  EMPTY_PREVIEW,
  channelListView,
  chatRowContextMenu,
  tileKind,
  unreadPillText,
  unreadTagText,
  type ChannelListInput,
} from '@/components/chat/ChannelList';
import type { ChannelSummary } from '@/lib/chat-reads';
import type { ConversationSummary } from '@/lib/chat/chat-store';
import { LIST_CARD_STACK } from '@/components/ui/ListCard';

// The rows are token-only: every colour is a CSS variable the
// .dark class swaps, so one class set serves light and dark.
const NOW = Date.parse('2026-09-28T10:00:00Z');

const dm: ChannelSummary = {
  channelId: 'c1',
  channelType: 'dm',
  title: 'Asha Rao',
  avatarUrl: null,
  agoraGroupId: null,
  groupId: null,
  peerUserId: 'u2',
  createdAt: 't',
};
const group: ChannelSummary = { ...dm, channelId: 'g1', channelType: 'group', title: 'Launch' };

const read: ConversationSummary = {
  lastMessageText: 'See you then',
  lastMessageTs: Date.parse('2026-09-28T09:00:00Z'),
  unread: 0,
};

/** One chat as the list renders it (ChannelCard, hooks and all), as markup. */
function card(
  channel: ChannelSummary,
  summary: ConversationSummary | undefined,
  state: {
    selected?: boolean;
    selecting?: boolean;
    checked?: boolean;
    divider?: boolean;
  } = {},
): string {
  return renderToStaticMarkup(
    <ChannelCard
      channel={channel}
      selected={state.selected === true}
      summary={summary}
      nowMs={NOW}
      timeZone="UTC"
      onSelect={() => {}}
      input={DEFAULT_LIST_INPUT}
      divider={state.divider === true}
      select={{
        active: state.selecting === true,
        chosen: state.checked === true,
        onEnter: () => {},
        onToggle: () => {},
      }}
    />,
  );
}

function tokenOnly(text: string): void {
  const banned = [`${'dark'}${':'}`, `bg-accent${'/'}`, `bg-fg-3${'/'}`, 'border-l-'];
  for (const literal of banned) expect(text).not.toContain(literal);
}

function html(el: ReactNode): string {
  return renderToStaticMarkup(<>{el}</>);
}

function view(channels: ChannelSummary[]): ReactElement {
  return channelListView({
    channels,
    hasChannels: true,
    selectedChannelId: null,
    onSelect: () => {},
    onNewChat: () => {},
  });
}

/** The ids of the chats in the one list, in order. */
function listIds(markup: string): string[] {
  const m = markup.match(/data-chat-list=""[^>]*>(.*?)<\/ul>/);
  if (m === null) return [];
  return [...(m[1] ?? '').matchAll(/aria-label="Open ([^"]*)"/g)].map((x) => x[1] ?? '');
}

const dm2: ChannelSummary = { ...dm, channelId: 'c2', title: 'Ravi Menon' };
const group2: ChannelSummary = { ...group, channelId: 'g2', title: 'Brand' };

describe('chat home: one list', () => {
  it('groups and DMs share one list in the given (recency) order, no section labels', () => {
    expect(tileKind(group)).toBe('wide');
    expect(tileKind(dm)).toBe('square');
    const markup = html(view([dm, group, dm2, group2]));
    expect(listIds(markup)).toEqual(['Asha Rao', 'Launch', 'Ravi Menon', 'Brand']);
    expect(markup).toContain(`data-chat-list="" class="${CHAT_ROW_LIST}"`);
    expect(markup).not.toContain('data-section-label');
    expect(markup).not.toContain('data-section=');
    expect(markup).not.toContain('>Groups<');
    expect(markup).not.toContain('>People<');
    expect(markup).not.toContain('data-tile');
    expect((view([group, dm]).props as { className: string }).className).toBe(CHAT_HOME_STACK);
    expect(CHAT_HOME_EDGE).toBe('px-4');
    tokenOnly(markup);
  });

  it('a stacked list of cards, 8 apart on the 16 edge, no grid', () => {
    expect(CHAT_ROW_LIST.split(' ')).toEqual(expect.arrayContaining(LIST_CARD_STACK.split(' ')));
    expect(CHAT_ROW_LIST.split(' ')).toContain('gap-2');
    expect(CHAT_ROW_LIST.split(' ')).toContain(CHAT_HOME_EDGE);
    const markup = html(view([dm, dm2, { ...dm, channelId: 'c3', title: 'Neha' }]));
    expect(markup).not.toContain('grid-cols');
    expect(CHAT_HOME_STACK).toBe('flex flex-col gap-2');
  });

  it('cards never draw a divider (8 between cards)', () => {
    const markup = html(view([group, group2, dm, dm2]));
    expect(markup).not.toContain('data-row-divider');
    expect(markup.match(/data-list-card=""/g)).toHaveLength(4);
  });

  it('unread 0 -> no tag and no dot; unread 3 -> the grey "3 new" tag and the dot', () => {
    expect(unreadPillText(0)).toBeNull();
    expect(unreadPillText(3)).toBe('3');
    expect(unreadTagText(0)).toBeNull();
    expect(unreadTagText(3)).toBe('3 new');
    for (const c of [dm, group]) {
      const quiet = card(c, read);
      expect(quiet).not.toContain('data-unread-tag');
      expect(quiet).not.toContain('data-list-card-unread');
      const loud = card(c, { ...read, unread: 3 });
      expect(loud).toMatch(/data-unread-tag=""[^>]*>[^]*?>3 new</);
      expect(loud).toContain('data-list-card-unread');
      // No black CountBadge anywhere on the list.
      expect(loud).not.toContain('data-count-badge');
    }
  });
});

describe('group chat: ui/ListCard', () => {
  it('48 picture (group photo or mark), name + time on line 1, preview + "3 new" + dot on line 2', () => {
    const h = card(group, { ...read, unread: 3 });
    expect(h).toContain('data-chat-list-item="card"');
    expect(h).toContain('data-list-card=""');
    expect(h).toMatch(/data-list-card-picture="image"[^>]*data-group-photo=""/);
    // The shared Avatar at its card role (48), group kind, clipped to radius 8.
    expect(h).toContain('data-avatar-role="card"');
    expect(h).toContain('width:48px;height:48px');
    expect(h).toMatch(/data-list-card-picture="image"[^>]*class="[^"]*h-12 w-12/);
    expect(h).toContain('rounded-lg');
    // formatAgo on the list's clock (sent an hour before NOW), meta role, line 1.
    const time = '1h';
    expect(h).toMatch(
      new RegExp(`data-list-card-line="1"[^]*font-mono[^"]*">${time}<[^]*data-list-card-line="2"`),
    );
    // One-line preview: no clamp, no third line.
    expect(h).not.toContain('line-clamp-2');
    expect(h).not.toContain('data-list-card-line="3"');
    expect(h.indexOf('3 new')).toBeGreaterThan(h.indexOf('See you then'));
    expect(h.indexOf('data-list-card-unread')).toBeGreaterThan(h.indexOf('3 new'));
    tokenOnly(h);
  });

  it('no ⋮ on the card: its one action (Hide chat) lives on the select bar', () => {
    const h = card(group, read);
    expect(h).not.toContain('data-list-card-more');
    expect(h).not.toContain('Actions for');
    expect(h.match(/<button/g)).toHaveLength(1);
  });

  it('no divider, asked or not', () => {
    expect(card(group, read)).not.toContain('data-row-divider');
    expect(card(group, read, { divider: true })).not.toContain('data-row-divider');
  });
});

describe('person chat: ui/ListCard, the same card as a group', () => {
  it('48 circle, name, preview, time + "99+ new"', () => {
    const h = card(dm, { ...read, unread: 120 });
    expect(h).toContain('data-chat-list-item="card"');
    expect(h).toContain('data-chat-kind="person"');
    expect(h).not.toContain('data-tile');
    expect(h).toMatch(/data-list-card-picture="person"[^>]*data-person-photo=""/);
    expect(h).toContain('data-avatar-role="card"');
    expect(h).toContain('width:48px;height:48px');
    expect(h).toContain('rounded-full');
    expect(h).toContain('>Asha Rao<');
    // formatAgo on the list's clock: sent an hour before NOW.
    const time = '1h';
    expect(h).toMatch(new RegExp(`font-mono[^"]*">${time}<`));
    expect(h).toContain('See you then<');
    expect(h).toContain('>99+ new<');
    tokenOnly(h);
  });

  it('no message yet: line 2 is there and empty, the card keeps its height', () => {
    const h = card(dm, undefined);
    expect(h).toContain('data-list-card-line="2"');
    expect(h).toContain(`data-preview-empty="" aria-hidden="true">${EMPTY_PREVIEW}<`);
    expect(h).not.toContain('No messages yet');
  });
});

describe('selected and select mode', () => {
  it('open on desktop or ticked while selecting: the one selected look, lit-selected', () => {
    for (const c of [dm, group]) {
      expect(card(c, read, { selected: true })).toContain('lit-selected');
      expect(card(c, read)).not.toContain('lit-selected');
      // Selecting: only the ticked cards are lit, the open chat is not.
      expect(card(c, read, { selected: true, selecting: true })).not.toContain('lit-selected');
      const checked = card(c, read, { selecting: true, checked: true });
      expect(checked).toContain('lit-selected');
      // ListCard draws the tick on the picture; no SelectCheck of the list's own.
      expect(checked).toContain('data-list-card-tick="on"');
      expect(checked).not.toContain('data-select-check');
      expect(checked).toContain('aria-pressed="true"');
      expect(checked).not.toContain('bg-accent-soft');
      tokenOnly(checked);
    }
  });

  it('empty preview: "No messages yet" in tertiary ink; group initials fallback', () => {
    const h = card(group, undefined);
    expect(h).toContain('No messages yet');
    expect(h).toContain('text-fg-3');
    expect(h).toContain('>L<');
  });

  it('no presence, last seen or typing on rows and tiles', () => {
    for (const c of [dm, group]) {
      const h = card(c, read);
      expect(h).not.toContain('data-presence');
      expect(h.toLowerCase()).not.toContain('last seen');
      expect(h.toLowerCase()).not.toContain('typing');
    }
  });

  it('"You: " prefix is unchanged on the group preview', () => {
    expect(card(group, { ...read, lastMessagePrefix: 'You' })).toContain('You: See you then');
  });
});

describe('D7: chat rows and tiles never select text or show the callout', () => {
  it('the card wrapper carries select-none and the no-callout class', () => {
    for (const c of [dm, group]) {
      const h = card(c, read);
      for (const cls of ['select-none', '[-webkit-touch-callout:none]']) expect(h).toContain(cls);
    }
  });

  it('contextmenu is caught on a coarse pointer only (the hold alone enters select mode)', () => {
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    chatRowContextMenu(true)?.({ preventDefault, stopPropagation });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(chatRowContextMenu(false)).toBeUndefined();
  });
});

describe('G1: one layout listener per ChannelList, not one per tile', () => {
  function cards(input?: ChannelListInput): ReactElement<Record<string, unknown>>[] {
    const tree = channelListView({
      channels: [dm, group],
      hasChannels: true,
      selectedChannelId: null,
      onSelect: () => {},
      onNewChat: () => {},
      ...(input !== undefined ? { input } : {}),
    });
    const out: ReactElement<Record<string, unknown>>[] = [];
    const walk = (n: ReactNode): void => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!isValidElement(n)) return;
      if (n.type === ChannelCard) out.push(n as ReactElement<Record<string, unknown>>);
      walk((n.props as { children?: ReactNode }).children);
    };
    walk(tree);
    return out;
  }

  it("every card gets the list's one input object", () => {
    const input: ChannelListInput = { layout: 'laptop', hoverMenu: true, coarsePointer: false };
    const tiles = cards(input);
    expect(tiles).toHaveLength(2);
    for (const c of tiles) expect(c.props.input).toBe(input);
    for (const c of cards()) expect(c.props.input).toBe(DEFAULT_LIST_INPUT);
  });

  it('ChannelCard reads no media query or layout hook of its own, and opens as "Open <name>"', () => {
    const source = readFileSync(join(process.cwd(), 'src/components/chat/ChannelList.tsx'), 'utf8');
    const body = source.slice(
      source.indexOf('export function ChannelCard('),
      source.indexOf('interface ChannelListContentProps'),
    );
    expect(body).not.toContain('useChatLayout(');
    expect(body).not.toContain('useHoverPointer(');
    expect(body).not.toContain('useCoarsePointer(');
    expect(body).toContain("'aria-label': channelTileLabel({");
    // The list reads them once.
    const list = source.slice(source.indexOf('export function ChannelList('));
    expect(list).toContain('useChannelListInput()');
  });
});

// 5 Nov 2026: on the chat list the whole People row, photo included, opens
// the chat. The enlarged photo lives only inside a DM (header photo). The
// photo sits inside the row's one tap surface.
describe('People row photo opens the chat (no photo popup)', () => {
  function mount(props: { onSelect: () => void; onToggle?: (id: string) => void }): {
    host: HTMLDivElement;
    unmount: () => void;
  } {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <ChannelCard
          channel={dm}
          selected={false}
          summary={read}
          nowMs={NOW}
          timeZone="UTC"
          onSelect={props.onSelect}
          input={DEFAULT_LIST_INPUT}
          {...(props.onToggle !== undefined
            ? {
                select: {
                  active: true,
                  chosen: false,
                  onEnter: () => {},
                  onToggle: () => props.onToggle?.(dm.channelId),
                },
              }
            : {})}
        />,
      );
    });
    return {
      host,
      unmount: () => {
        act(() => root.unmount());
        host.remove();
      },
    };
  }

  it('a DM card: no control in the photo slot; the photo lets taps through to the card button', () => {
    const { host, unmount } = mount({ onSelect: () => {} });
    const slot = host.querySelector('[data-person-photo]');
    expect(slot).not.toBeNull();
    expect(slot?.querySelector('[role="button"], button, [tabindex]')).toBeNull();
    // The picture lives in the pass-through body laid over the one card button.
    expect(slot?.closest('[data-list-card-body]')?.className).toContain('pointer-events-none');
    const press = host.querySelector('button[aria-label^="Open "]');
    expect(press?.hasAttribute('data-list-card-press')).toBe(true);
    expect(press?.getAttribute('aria-label')).toMatch(/^Open Asha Rao/);
    unmount();
  });

  it('a tap anywhere on the card (the card button) opens the chat', () => {
    const onSelect = vi.fn();
    const { host, unmount } = mount({ onSelect });
    const body = host.querySelector('button[aria-label^="Open "]');
    act(() => {
      (body as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenLastCalledWith(dm);
    unmount();
  });

  it('selecting: a tap on the card toggles it, never opens it', () => {
    const onSelect = vi.fn();
    const onToggle = vi.fn();
    const { host, unmount } = mount({ onSelect, onToggle });
    const body = host.querySelector('button[aria-label^="Open "]');
    act(() => {
      (body as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onToggle).toHaveBeenCalledWith(dm.channelId);
    expect(onSelect).not.toHaveBeenCalled();
    unmount();
  });
});
