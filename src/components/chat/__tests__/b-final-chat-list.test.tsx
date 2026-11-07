// @vitest-environment jsdom
// Chat list on ui/ListCard: Personal notes, groups and people are one card
// style in one list. The 40 picture (person circle, group photo or mark, the
// caller's own photo for notes), the name + how long ago on line 1, the
// one-line preview + "3 new" tag + unread dot on line 2. No ⋮: long-press
// selects. Every row is the same 60 height. No ui/Tile and no ui/Row.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  ChannelCard,
  DEFAULT_LIST_INPUT,
  EMPTY_PREVIEW,
  channelListSkeleton,
  channelListView,
  notesTile,
} from '@/components/chat/ChannelList';
import { ListCardBox } from '@/components/ui/ListCard';
import { Row } from '@/components/ui/Row';
import { Tile } from '@/components/ui/Tile';
import type { ChannelSummary } from '@/lib/chat-reads';
import type { ConversationSummary } from '@/lib/chat/chat-store';
import { getFillCount } from '@/lib/use-fill-count';

const NOW = Date.parse('2026-11-06T10:00:00Z');

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
const notes: ChannelSummary = { ...dm, channelId: 'n1', title: 'Personal notes' };

const read: ConversationSummary = {
  lastMessageText: 'See you then',
  lastMessageTs: Date.parse('2026-11-06T09:00:00Z'),
  unread: 0,
};

function card(
  channel: ChannelSummary,
  summary: ConversationSummary | undefined,
  /** plain: no select (a list without select mode); selecting: select mode on. */
  opts: { selecting?: boolean; plain?: boolean } = {},
): string {
  return renderToStaticMarkup(
    <ChannelCard
      channel={channel}
      selected={false}
      summary={summary}
      nowMs={NOW}
      timeZone="UTC"
      onSelect={() => {}}
      input={DEFAULT_LIST_INPUT}
      {...(opts.plain === true
        ? {}
        : {
            select: {
              active: opts.selecting === true,
              chosen: false,
              onEnter: () => {},
              onToggle: () => {},
            },
          })}
    />,
  );
}

/** The class list of the element carrying `attr`. */
function classOf(html: string, attr: string): string[] {
  const m = html.match(new RegExp(`<[a-z]+[^>]*${attr}[^>]*class="([^"]*)"`));
  return (m?.[1] ?? '').split(' ');
}

function findAll(node: ReactNode, pick: (el: ReactElement) => boolean): ReactElement[] {
  const out: ReactElement[] = [];
  const walk = (n: ReactNode): void => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!isValidElement(n)) return;
    if (pick(n)) out.push(n);
    walk((n.props as { children?: ReactNode }).children);
  };
  walk(node);
  return out;
}

describe('people cards are ui/ListCard, exactly like group cards', () => {
  it('a person and a group draw the same frame, body, picture box and lines', () => {
    const person = card(dm, read);
    const grp = card(group, read);
    for (const attr of [
      'data-list-card=""',
      'data-list-card-body=""',
      'data-list-card-line="1"',
      'data-list-card-preview=""',
      'data-list-card-line="2"',
    ]) {
      expect(classOf(person, attr), attr).toEqual(classOf(grp, attr));
    }
    expect(classOf(person, 'data-list-card-body=""')).toEqual(
      expect.arrayContaining(['gap-3', 'items-center']),
    );
    // The flat row frame carries the 16 sides; the body has no padding of its own.
    expect(classOf(person, 'data-list-card-body=""')).not.toContain('p-3');
    expect(classOf(person, 'data-list-card=""')).toEqual(
      expect.arrayContaining(['-mx-4', 'px-4', 'h-15']),
    );
    expect(person).not.toContain('data-list-card-line="3"');
  });

  it('slots: 40 picture, name heading + time meta, preview secondary + "4 new" tag + dot', () => {
    const h = card(dm, { ...read, unread: 4 });
    expect(h).toContain('data-chat-list-item="card"');
    expect(h).toContain('data-avatar-role="card"');
    expect(h).toContain('width:40px;height:40px');
    // Unread: the heading's bold; read: the same size at regular weight.
    expect(h).toMatch(/text-lg font-semibold[^"]*">Asha Rao</);
    expect(card(dm, read)).toMatch(/text-lg[^"]*font-normal[^"]*">Asha Rao</);
    expect(h).toMatch(/font-mono[^"]*">1h</);
    expect(h).toMatch(
      /data-list-card-preview=""[^>]*class="[^"]*truncate[^"]*"><span>See you then</,
    );
    expect(h).not.toContain('line-clamp-2');
    expect(h.indexOf('4 new')).toBeGreaterThan(h.indexOf('See you then'));
    expect(h.indexOf('data-list-card-unread')).toBeGreaterThan(h.indexOf('4 new'));
    expect(h).not.toContain('data-count-badge');
    expect(h).not.toContain('data-tile');
    expect(h).not.toContain('data-row=""');
  });

  it('no message yet: line 2 stays (an empty preview), the card keeps its height', () => {
    const h = card(dm, undefined);
    expect(h).toContain('data-list-card-line="2"');
    expect(h).toContain(`data-preview-empty="" aria-hidden="true">${EMPTY_PREVIEW}<`);
    expect(EMPTY_PREVIEW.trim()).toBe('');
    expect(EMPTY_PREVIEW.length).toBe(1);
  });

  it('card structure holds across states: read, unread, empty, selecting', () => {
    const base = card(dm, read);
    for (const h of [
      card(dm, { ...read, unread: 9 }),
      card(dm, undefined),
      card(dm, read, { selecting: true }),
    ]) {
      for (const attr of ['data-list-card-body=""', 'data-list-card-preview=""']) {
        expect(classOf(h, attr)).toEqual(classOf(base, attr));
      }
    }
    // Select mode: ListCard's tick (ui/SelectCheck, the one select circle) on the picture.
    const selecting = card(dm, read, { selecting: true });
    expect(selecting).toMatch(/data-list-card-picture="person"[^]*?data-list-card-tick="off"/);
    expect(selecting.match(/data-select-check=/g)).toHaveLength(1);
    expect(selecting).toMatch(/data-select-check="off" data-list-card-tick="off"/);
  });

  it('no ⋮ on any card: one button, the whole-card tap surface', () => {
    for (const h of [card(dm, read), card(group, read), card(dm, read, { selecting: true })]) {
      expect(h).not.toContain('data-list-card-more');
      expect(h).not.toContain('Actions for');
      expect(h.match(/<button/g)).toHaveLength(1);
    }
  });

  it('rows stack touching, with no dividers', () => {
    const html = renderToStaticMarkup(
      channelListView({
        channels: [dm, { ...dm, channelId: 'c2', title: 'Ravi' }, group],
        hasChannels: true,
        selectedChannelId: null,
        onSelect: () => {},
        onNewChat: () => {},
      }),
    );
    expect(html).not.toContain('grid-cols');
    expect(html).not.toContain('data-row-divider');
    expect(html.match(/data-list-card=""/g)).toHaveLength(3);
    expect(classOf(html, 'data-chat-list=""').filter((c) => c.startsWith('gap'))).toEqual([]);
  });
});

describe('notes, groups and people: one card style', () => {
  it("the notes card draws the same frame as a chat card, with the caller's own picture", () => {
    const h = renderToStaticMarkup(
      notesTile({ notes, selected: false, selecting: false, onSelect: () => {} }),
    );
    // Notes is never selectable: compare with a chat card in a list without select mode.
    const chat = card(group, read, { plain: true });
    for (const attr of [
      'data-list-card=""',
      'data-list-card-body=""',
      'data-list-card-preview=""',
    ]) {
      expect(classOf(h, attr)).toEqual(classOf(chat, attr));
    }
    // The person picture slot (40, round): the caller's own picture, not the 72 notes avatar.
    expect(h).toContain('data-list-card-picture="person"');
    expect(h).toContain('data-avatar-role="card"');
    expect(h).not.toContain('data-notes-avatar');
    expect(h).toMatch(/data-notes-tile=""[^>]*data-list-card=""/);
    expect(h).toMatch(/<button[^>]*aria-label="Open Personal notes"/);
  });

  it('in the one list, notes is a card among the chats, in the order given (recency)', () => {
    const html = renderToStaticMarkup(
      channelListView({
        channels: [dm, notes, group],
        notes,
        hasChannels: true,
        selectedChannelId: null,
        onSelect: () => {},
        onNewChat: () => {},
      }),
    );
    const order = [...html.matchAll(/aria-label="Open ([^",]*)/g)].map((m) => m[1]);
    expect(order).toEqual([dm.title, 'Personal notes', group.title]);
    expect(html.match(/data-notes-tile=""/g)).toHaveLength(1);
    expect(html).not.toContain('data-section-label');
  });

  it('the loading shell is ListCardBox only (no Tile, no Row)', () => {
    const tree = channelListSkeleton();
    expect(findAll(tree, (el) => el.type === Tile)).toHaveLength(0);
    expect(findAll(tree, (el) => el.type === Row)).toHaveLength(0);
    // Six uniform cards, no section labels.
    expect(findAll(tree, (el) => el.type === ListCardBox)).toHaveLength(getFillCount());
  });

  it('ChannelList never imports ui/Tile or ui/Row', () => {
    const path = resolve(process.cwd(), 'src/components/chat/ChannelList.tsx');
    const src = readFileSync(path, 'utf8');
    expect(src).not.toContain("from '@/components/ui/Tile'");
    expect(src).not.toContain("from '@/components/ui/Row'");
  });
});
