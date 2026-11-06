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
  CHAT_ROW_PHOTO,
  EMPTY_PREVIEW,
  SECTION_LABEL_TYPE,
  channelListView,
  channelRowSelected,
  chatRowContextMenu,
  splitSections,
  tileKind,
  unreadPillText,
  type ChannelListInput,
} from '@/components/chat/ChannelList';
import type { ChannelSummary } from '@/lib/chat-reads';
import type { ConversationSummary } from '@/lib/chat/chat-store';
import { formatChatTime } from '@/lib/time';

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
    menu?: boolean;
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
      {...(state.selecting === true ? { onToggle: () => {}, checked: state.checked === true } : {})}
      {...(state.menu === true ? { onLongPress: () => {}, onHide: () => {} } : {})}
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

/** The ids of the chats inside one section's list, in order. */
function sectionIds(markup: string, section: 'groups' | 'people'): string[] {
  const m = markup.match(new RegExp(`data-section="${section}"[^>]*>(.*?)</ul>`));
  if (m === null) return [];
  return [...(m[1] ?? '').matchAll(/aria-label="Open ([^"]*)"/g)].map((x) => x[1] ?? '');
}

const dm2: ChannelSummary = { ...dm, channelId: 'c2', title: 'Ravi Menon' };
const group2: ChannelSummary = { ...group, channelId: 'g2', title: 'Brand' };

const esc = (cls: string): string => cls.replaceAll('&', '&amp;').replaceAll('>', '&gt;');

describe('chat home sections', () => {
  it('group channel -> a Row in Groups; DM channel -> a Row in People', () => {
    expect(tileKind(group)).toBe('wide');
    expect(tileKind(dm)).toBe('square');
    const markup = html(view([dm, group, dm2, group2]));
    expect(sectionIds(markup, 'groups')).toEqual(['Launch', 'Brand']);
    expect(sectionIds(markup, 'people')).toEqual(['Asha Rao', 'Ravi Menon']);
    // Groups first, then People; labels in that order.
    expect(markup.indexOf('>Groups<')).toBeLessThan(markup.indexOf('>People<'));
    expect(markup).toContain(`data-section="groups" class="${CHAT_ROW_LIST}"`);
    expect(markup).toContain(`data-section="people" class="${CHAT_ROW_LIST}"`);
    expect(markup).not.toContain('data-tile');
    expect((view([group, dm]).props as { className: string }).className).toBe(CHAT_HOME_STACK);
  });

  it('keeps the recency order within each section', () => {
    expect(splitSections([dm2, group2, dm, group])).toEqual({
      groups: [group2, group],
      people: [dm2, dm],
    });
  });

  it('zero groups -> no Groups label; People label takes the first padding', () => {
    const markup = html(view([dm, dm2]));
    expect(markup).not.toContain('data-section-label="groups"');
    expect(markup).not.toContain('>Groups<');
    expect(markup).not.toContain('data-section="groups"');
    expect(markup).toContain(
      `data-section-label="people" class="${SECTION_LABEL_TYPE} ${CHAT_HOME_EDGE} pt-1"`,
    );
  });

  it('zero DMs -> no People label', () => {
    const markup = html(view([group, group2]));
    expect(markup).not.toContain('data-section-label="people"');
    expect(markup).not.toContain('>People<');
    expect(markup).not.toContain('data-section="people"');
    expect(markup).toContain(
      `data-section-label="groups" class="${SECTION_LABEL_TYPE} ${CHAT_HOME_EDGE} pt-1"`,
    );
  });

  it('second label gets 12px top padding; labels are 12/600 uppercase secondary on the 16 edge', () => {
    const markup = html(view([group, dm]));
    expect(markup).toContain(
      `data-section-label="people" class="${SECTION_LABEL_TYPE} ${CHAT_HOME_EDGE} pt-3"`,
    );
    for (const t of ['text-sm', 'font-semibold', 'uppercase', 'tracking-[0.06em]', 'text-fg-2']) {
      expect(SECTION_LABEL_TYPE.split(' ')).toContain(t);
    }
    expect(CHAT_HOME_EDGE).toBe('px-4');
    tokenOnly(markup);
  });

  it('People: a stacked list of Rows like Groups, no grid', () => {
    expect(CHAT_ROW_LIST).toBe('flex flex-col');
    const markup = html(view([dm, dm2, { ...dm, channelId: 'c3', title: 'Neha' }]));
    expect(markup).not.toContain('grid-cols');
    // Rows draw their own 12 chat edge, so the stack itself has none.
    expect(CHAT_HOME_STACK).toBe('flex flex-col gap-2');
  });

  it('group and people rows: a divider under every row but the last (inset 56, the text edge)', () => {
    const markup = html(view([group, group2, { ...group, channelId: 'g3', title: 'Ops' }]));
    expect(markup.match(/data-row-divider=""/g)).toHaveLength(2);
    expect(markup).toMatch(/data-row-divider=""[^>]*left-14/);
    const people = html(view([dm, dm2, { ...dm, channelId: 'c3', title: 'Neha' }]));
    expect(people.match(/data-row-divider=""/g)).toHaveLength(2);
  });

  it('unread 0 -> no badge, unread 3 -> badge "3"', () => {
    expect(unreadPillText(0)).toBeNull();
    expect(unreadPillText(3)).toBe('3');
    expect(card(dm, read)).not.toContain('data-count-badge');
    expect(card(dm, { ...read, unread: 3 })).toMatch(/data-count-badge="[^"]*"[^>]*>3</);
    expect(card(group, read)).not.toContain('data-count-badge');
    expect(card(group, { ...read, unread: 3 })).toMatch(/data-count-badge="[^"]*"[^>]*>3</);
  });
});

describe('group chat: ui/Row', () => {
  it('72 tall, 32 avatar column at the 12 chat edge, time meta, one-line preview, badge on line 2', () => {
    const h = card(group, { ...read, unread: 3 });
    expect(h).toContain('data-chat-list-item="row"');
    expect(h).toContain('data-row=""');
    expect(h).toContain('min-h-18');
    expect(h).toMatch(/data-row-leading=""[^>]*w-8/);
    expect(h).toMatch(/class="[^"]*rounded-none[^"]*\bpx-3\b[^"]*min-h-18/);
    expect(h).toContain(`data-group-photo="" class="${esc(CHAT_ROW_PHOTO)}"`);
    // The shared Avatar at its header role, group kind: a 32px rounded square.
    expect(h).toContain('data-avatar-role="header"');
    expect(h).toContain('width:32px;height:32px');
    expect(h).toContain('rounded-lg lit-avatar inline-flex');
    expect(CHAT_ROW_PHOTO).not.toContain('!');
    // Time in the meta role; the preview one line (no clamp).
    const time = formatChatTime(read.lastMessageTs, new Date(NOW), 'UTC');
    expect(h).toMatch(new RegExp(`font-mono[^"]*">${time}<`));
    expect(h).not.toContain('line-clamp');
    // The badge sits on the second line, after the preview.
    expect(h).toContain('data-row-badge');
    expect(h.indexOf('data-count-badge')).toBeGreaterThan(h.indexOf('See you then'));
    tokenOnly(h);
  });

  it('the ⋯ is the Row trailing (ActionMenuTrigger, the trailing rule), never inside the tap surface', () => {
    const h = card(group, read, { menu: true });
    expect(h).toMatch(/data-row-more=""[^>]*pr-3/);
    expect(h).toMatch(/aria-label="Actions for Launch"[^>]*-mr-3/);
    // The tap surface closes before the ⋯ opens: buttons never nest.
    const tap = h.indexOf('aria-label="Open Launch');
    const more = h.indexOf('aria-label="Actions for Launch"');
    expect(h.slice(tap, more)).toContain('</button>');
  });

  it('divider only when asked', () => {
    expect(card(group, read)).not.toContain('data-row-divider');
    expect(card(group, read, { divider: true })).toContain('data-row-divider');
  });
});

describe('person chat: ui/Row, the same row as a group', () => {
  it('72 tall, 32 circle, name + time, one-line preview, badge on line 2', () => {
    const h = card(dm, { ...read, unread: 120 });
    expect(h).toContain('data-chat-list-item="row"');
    expect(h).toContain('data-chat-kind="person"');
    expect(h).not.toContain('data-tile');
    expect(h).toContain('min-h-18');
    expect(h).toContain(`data-person-photo="" class="${esc(CHAT_ROW_PHOTO)}"`);
    expect(h).toContain('data-avatar-role="header"');
    expect(h).toContain('width:32px;height:32px');
    expect(h).toContain('>Asha Rao<');
    const time = formatChatTime(read.lastMessageTs, new Date(NOW), 'UTC');
    expect(h).toMatch(new RegExp(`font-mono[^"]*">${time}<`));
    expect(h).toContain('See you then<');
    expect(h.indexOf('data-count-badge')).toBeGreaterThan(h.indexOf('See you then'));
    expect(h).toContain('>99+<');
    tokenOnly(h);
  });

  it('the ⋯ is the Row trailing, outside the one tap surface that holds the photo', () => {
    const h = card(dm, read, { menu: true });
    const tap = h.indexOf('aria-label="Open Asha Rao');
    const close = h.indexOf('</button>', tap);
    expect(h.indexOf('data-person-photo')).toBeGreaterThan(tap);
    expect(h.indexOf('data-person-photo')).toBeLessThan(close);
    expect(h.indexOf('data-row-more')).toBeGreaterThan(close);
    expect(h).toMatch(/aria-label="Actions for Asha Rao"[^>]*-mr-3/);
  });

  it('no message yet: line 2 is reserved and empty, the row stays 72', () => {
    const h = card(dm, undefined);
    expect(h).toContain('min-h-18');
    expect(h).toContain(`data-preview-empty="" aria-hidden="true">${EMPTY_PREVIEW}<`);
    expect(h).not.toContain('No messages yet');
  });
});

describe('selected and select mode', () => {
  it('open on desktop or checked while selecting: the one selected look, lit-selected', () => {
    expect(channelRowSelected({ selected: true, selecting: false, checked: false })).toBe(true);
    expect(channelRowSelected({ selected: false, selecting: true, checked: true })).toBe(true);
    expect(channelRowSelected({ selected: true, selecting: true, checked: false })).toBe(false);
    for (const c of [dm, group]) {
      expect(card(c, read, { selected: true })).toContain('lit-selected');
      expect(card(c, read)).not.toContain('lit-selected');
      const checked = card(c, read, { selecting: true, checked: true });
      expect(checked).toContain('lit-selected');
      expect(checked).toContain('data-select-check="on"');
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
  it('the card carries select-none and the no-callout class', () => {
    for (const c of [dm, group]) {
      const h = card(c, read);
      for (const cls of ['select-none', '[-webkit-touch-callout:none]']) expect(h).toContain(cls);
    }
  });

  it('contextmenu default is prevented on a coarse pointer only', () => {
    const preventDefault = vi.fn();
    chatRowContextMenu(true)?.({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
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
          {...(props.onToggle !== undefined ? { onToggle: props.onToggle, checked: false } : {})}
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

  it('a DM row: no button inside the photo slot; the photo sits inside the row surface', () => {
    const { host, unmount } = mount({ onSelect: () => {} });
    const slot = host.querySelector('[data-person-photo]');
    expect(slot).not.toBeNull();
    expect(slot?.className).toBe(CHAT_ROW_PHOTO);
    expect(slot?.querySelector('[role="button"], button, [tabindex]')).toBeNull();
    const press = host.querySelector('button[aria-label^="Open "]');
    expect(press?.contains(slot ?? null)).toBe(true);
    expect(press?.getAttribute('aria-label')).toMatch(/^Open Asha Rao/);
    unmount();
  });

  it('a click on the photo calls the same open handler as the tile body', () => {
    const onSelect = vi.fn();
    const { host, unmount } = mount({ onSelect });
    const photo = host.querySelector('[data-person-photo] [data-avatar-role="header"]');
    expect(photo).not.toBeNull();
    act(() => {
      (photo as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(dm);
    const body = host.querySelector('button[aria-label^="Open "]');
    act(() => {
      (body as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onSelect).toHaveBeenLastCalledWith(dm);
    unmount();
  });

  it('selecting: a click on the photo toggles the tile, never opens it', () => {
    const onSelect = vi.fn();
    const onToggle = vi.fn();
    const { host, unmount } = mount({ onSelect, onToggle });
    const photo = host.querySelector('[data-person-photo] [data-avatar-role="header"]');
    act(() => {
      (photo as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onToggle).toHaveBeenCalledWith(dm.channelId);
    expect(onSelect).not.toHaveBeenCalled();
    unmount();
  });
});
