import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// ChannelList's import graph pulls the real agora-chat browser SDK; mock it.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import {
  CHANNEL_ROW_BUTTON,
  CHAT_HOME_STACK,
  ChannelCard,
  DEFAULT_LIST_INPUT,
  GROUP_NAME_TYPE,
  GROUP_PREVIEW_TYPE,
  GROUP_TILE_LIST,
  GROUP_TILE_PHOTO,
  PEOPLE_TILE_GRID,
  PERSON_NAME_TYPE,
  PERSON_PREVIEW_TYPE,
  PERSON_TILE_PHOTO,
  SECTION_LABEL_TYPE,
  channelListView,
  channelRowBody,
  channelRowClass,
  chatRowContextMenu,
  splitSections,
  tileKind,
  unreadPillText,
  type ChannelListInput,
} from '@/components/chat/ChannelList';
import type { ChannelSummary } from '@/lib/chat-reads';
import type { ConversationSummary } from '@/lib/chat/chat-store';

// The tile is token-only: every colour is a CSS variable the .dark class swaps,
// so one class set serves light and dark. The snapshots pin that set; the
// assertions below check no theme-specific literal ever slips in.
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

function tile(
  channel: ChannelSummary,
  summary: ConversationSummary | undefined,
  state: { selected?: boolean; selecting?: boolean; checked?: boolean } = {},
): { cls: string; html: string; classes: string[] } {
  const selecting = state.selecting === true;
  const checked = state.checked === true;
  const html = renderToStaticMarkup(
    <>{channelRowBody({ channel, summary, nowMs: NOW, timeZone: 'UTC', selecting, checked })}</>,
  );
  return {
    html,
    // The snapshot pins class sets only (no inline avatar tint), in render order.
    classes: [...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1] ?? ''),
    cls: channelRowClass({
      kind: tileKind(channel),
      selected: state.selected === true,
      selecting,
      checked,
    }),
  };
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

/** The ids of the tiles inside one section's list, in order. */
function sectionIds(markup: string, section: 'groups' | 'people'): string[] {
  const m = markup.match(new RegExp(`data-section="${section}"[^>]*>(.*?)</ul>`));
  if (m === null) return [];
  return [...(m[1] ?? '').matchAll(/aria-label="Open ([^"]*)"/g)].map((x) => x[1] ?? '');
}

const dm2: ChannelSummary = { ...dm, channelId: 'c2', title: 'Ravi Menon' };
const group2: ChannelSummary = { ...group, channelId: 'g2', title: 'Brand' };

const esc = (cls: string): string => cls.replaceAll('&', '&amp;').replaceAll('>', '&gt;');

describe('chat home sections', () => {
  it('group channel -> Groups section wide tile; DM channel -> People section square tile', () => {
    expect(tileKind(group)).toBe('wide');
    expect(tileKind(dm)).toBe('square');
    const markup = html(view([dm, group, dm2, group2]));
    expect(sectionIds(markup, 'groups')).toEqual(['Launch', 'Brand']);
    expect(sectionIds(markup, 'people')).toEqual(['Asha Rao', 'Ravi Menon']);
    // Groups first, then People; labels in that order.
    expect(markup.indexOf('>Groups<')).toBeLessThan(markup.indexOf('>People<'));
    expect(markup).toContain(`data-section="groups" class="${GROUP_TILE_LIST}"`);
    expect(markup).toContain(`data-section="people" class="${PEOPLE_TILE_GRID}"`);
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
    expect(markup).toContain(`data-section-label="people" class="${SECTION_LABEL_TYPE} px-1 pt-1"`);
  });

  it('zero DMs -> no People label', () => {
    const markup = html(view([group, group2]));
    expect(markup).not.toContain('data-section-label="people"');
    expect(markup).not.toContain('>People<');
    expect(markup).not.toContain('data-section="people"');
    expect(markup).toContain(`data-section-label="groups" class="${SECTION_LABEL_TYPE} px-1 pt-1"`);
  });

  it('second label gets 12px top padding; labels are 12/600 uppercase secondary', () => {
    const markup = html(view([group, dm]));
    expect(markup).toContain(`data-section-label="people" class="${SECTION_LABEL_TYPE} px-1 pt-3"`);
    for (const t of ['text-xs', 'font-semibold', 'uppercase', 'tracking-[0.06em]', 'text-fg-2']) {
      expect(SECTION_LABEL_TYPE.split(' ')).toContain(t);
    }
    tokenOnly(markup);
  });

  it('People grid: 2 fluid columns, 168px rows, 10px gap, no dense packing or spans', () => {
    expect(PEOPLE_TILE_GRID).toBe(
      'grid grid-cols-[repeat(2,minmax(0,1fr))] auto-rows-[168px] gap-[10px]',
    );
    // An odd count leaves the last cell empty: nothing spans or stretches.
    const markup = html(view([dm, dm2, { ...dm, channelId: 'c3', title: 'Neha' }]));
    expect(markup).not.toContain('col-span');
    expect(markup).not.toContain('grid-flow');
    expect(CHAT_HOME_STACK).toBe('flex flex-col gap-2 px-[14px]');
  });

  it('unread 0 -> no pill, unread 3 -> pill "3"', () => {
    expect(unreadPillText(0)).toBeNull();
    expect(unreadPillText(3)).toBe('3');
    expect(tile(dm, read).html).not.toContain('data-unread-pill');
    expect(tile(dm, { ...read, unread: 3 }).html).toMatch(/data-unread-pill="[^"]*"[^>]*>3</);
    expect(tile(group, read).html).not.toContain('data-unread-pill');
    expect(tile(group, { ...read, unread: 3 }).html).toMatch(/data-unread-pill="[^"]*"[^>]*>3</);
  });
});

describe('chat home tile', () => {
  it('People square: 168 tall centred column, 72px disc, 1-line preview, corner pill capped at 99+', () => {
    const t = tile(dm, { ...read, unread: 120 });
    expect(t.cls).toContain('h-[168px]');
    expect(t.cls.split(' ')).toEqual(
      expect.arrayContaining(['flex-col', 'items-center', 'relative', 'px-3', 'pt-4', 'pb-[14px]']),
    );
    expect(t.cls).toContain('bg-panel');
    expect(t.cls.split(' ')).toEqual(expect.arrayContaining(['border', 'border-border']));
    expect(t.cls).toContain('rounded-[18px]');
    expect(t.html).toContain(`data-person-photo="" class="${esc(PERSON_TILE_PHOTO)}"`);
    expect(PERSON_TILE_PHOTO).toContain('[&>*]:!h-[72px] [&>*]:!w-[72px]');
    expect(PERSON_TILE_PHOTO).not.toContain('rounded');
    expect(t.html).toContain(`min-w-0 max-w-full truncate ${PERSON_PREVIEW_TYPE}`);
    expect(t.html).not.toContain('line-clamp');
    expect(t.html).toContain('mt-auto');
    expect(t.html).toMatch(/absolute right-3 top-3 flex"><span data-unread-pill/);
    expect(t.html).toContain('>99+<');
    tokenOnly(t.cls + t.html);
    expect({ tile: t.cls, classes: t.classes }).toMatchSnapshot();
  });

  it('Groups wide: 100 tall row, 76px rounded-square photo, 2-line preview, pill far right', () => {
    const t = tile(group, { ...read, unread: 3 });
    expect(t.cls).toContain('h-[100px]');
    expect(t.cls).not.toContain('flex-col');
    expect(t.cls.split(' ')).toEqual(
      expect.arrayContaining(['w-full', 'rounded-[18px]', 'py-3', 'pl-3', 'pr-4', 'items-center']),
    );
    expect(t.html).toContain(`data-group-photo="" class="${esc(GROUP_TILE_PHOTO)}"`);
    expect(GROUP_TILE_PHOTO).toContain('[&>*]:!h-[76px] [&>*]:!w-[76px] [&>*]:!rounded-[18px]');
    expect(t.html).toContain(`break-words line-clamp-2 ${GROUP_PREVIEW_TYPE}`);
    // The pill is the last thing in the row, after the text column.
    expect(t.html.indexOf('data-unread-pill')).toBeGreaterThan(t.html.indexOf('See you then'));
    tokenOnly(t.cls + t.html);
    expect({ tile: t.cls, classes: t.classes }).toMatchSnapshot();
  });

  it('selected (desktop active): panel-2 fill', () => {
    const t = tile(dm, read, { selected: true });
    expect(t.cls).toContain('bg-panel-2');
    expect(t.cls).not.toContain('bg-accent-soft');
    tokenOnly(t.cls + t.html);
  });

  it('checked in select mode: accent tint and the on select circle', () => {
    for (const c of [dm, group]) {
      const t = tile(c, read, { selecting: true, checked: true });
      expect(t.cls).toContain('bg-accent-soft');
      expect(t.html).toContain('data-select-check="on"');
      tokenOnly(t.cls + t.html);
    }
  });

  it('empty preview: "No messages yet" in tertiary ink; group initials fallback', () => {
    const t = tile(group, undefined);
    expect(t.html).toContain('No messages yet');
    expect(t.html).toContain('text-fg-3');
    expect(t.html).toContain('>L<');
    tokenOnly(t.cls + t.html);
  });

  it('name truncates and previews clamp or truncate, so text never overflows the tile', () => {
    expect(tile(dm, read).html).toContain(`min-w-0 truncate text-fg ${PERSON_NAME_TYPE}`);
    expect(tile(group, read).html).toContain(`min-w-0 truncate text-fg ${GROUP_NAME_TYPE}`);
    expect(tile(dm, read).html).toContain('flex w-full min-w-0 justify-center');
  });

  it('no presence, last seen or typing on tiles', () => {
    for (const c of [dm, group]) {
      const h = tile(c, read).html;
      expect(h).not.toContain('data-presence');
      expect(h.toLowerCase()).not.toContain('last seen');
      expect(h.toLowerCase()).not.toContain('typing');
    }
  });

  it('"You: " prefix is unchanged', () => {
    expect(tile(dm, { ...read, lastMessagePrefix: 'You' }).html).toContain('You: See you then');
    expect(tile(group, { ...read, lastMessagePrefix: 'You' }).html).toContain('You: See you then');
  });
});

describe('D7: chat home tiles never select text or show the callout', () => {
  it('the tile button carries select-none and the no-callout class', () => {
    for (const cls of ['select-none', '[-webkit-touch-callout:none]']) {
      expect(tile(dm, read).cls.split(' ')).toContain(cls);
      expect(CHANNEL_ROW_BUTTON.split(' ')).toContain(cls);
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

  it("every tile gets the list's one input object", () => {
    const input: ChannelListInput = { layout: 'laptop', hoverMenu: true, coarsePointer: false };
    const tiles = cards(input);
    expect(tiles).toHaveLength(2);
    for (const card of tiles) expect(card.props.input).toBe(input);
    for (const card of cards()) expect(card.props.input).toBe(DEFAULT_LIST_INPUT);
  });

  it('ChannelCard reads no media query or layout hook of its own, and opens as "Open <name>"', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./ChannelList.tsx', import.meta.url)),
      'utf8',
    );
    const card = source.slice(
      source.indexOf('export function ChannelCard('),
      source.indexOf('interface ChannelListContentProps'),
    );
    expect(card).not.toContain('useChatLayout(');
    expect(card).not.toContain('useMediaQuery(');
    expect(card).toContain('aria-label={channelTileLabel({');
    // The list reads them once.
    const list = source.slice(source.indexOf('export function ChannelList('));
    expect(list).toContain('useChannelListInput()');
  });
});
