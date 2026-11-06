// @vitest-environment jsdom
// Chat list on ui/ListCard: Personal notes, Groups and People are one card
// style. The 72 picture (person circle, group photo or mark, the notes icon),
// the name + unread dot on line 1, the 2-line preview on line 2, the time and
// the "3 new" tag on line 3 with the ⋯ (ActionMenuTrigger, TRAILING_PULL).
// Every card is the same height. No ui/Tile and no ui/Row in the list.
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
import { TRAILING_PULL } from '@/components/ui/layout';
import type { ChannelSummary } from '@/lib/chat-reads';
import type { ConversationSummary } from '@/lib/chat/chat-store';

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
  opts: { menu?: boolean; selecting?: boolean } = {},
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
      {...(opts.menu === true ? { onLongPress: () => {}, onHide: () => {} } : {})}
      {...(opts.selecting === true ? { onToggle: () => {}, checked: false } : {})}
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
      'data-list-card-line="3"',
    ]) {
      expect(classOf(person, attr), attr).toEqual(classOf(grp, attr));
    }
    expect(classOf(person, 'data-list-card-body=""')).toEqual(
      expect.arrayContaining(['p-4', 'gap-3', 'items-start']),
    );
  });

  it('slots: 72 picture, name heading + dot, preview secondary, time meta + "4 new" tag', () => {
    const h = card(dm, { ...read, unread: 4 });
    expect(h).toContain('data-chat-list-item="card"');
    expect(h).toContain('data-avatar-role="profile"');
    expect(h).toContain('width:72px;height:72px');
    expect(h).toMatch(/text-lg font-semibold[^"]*">Asha Rao</);
    expect(h).toContain('data-list-card-unread');
    expect(h).toMatch(/font-mono[^"]*">[^<]+</);
    expect(h).toMatch(/line-clamp-2[^"]*"><span>See you then</);
    expect(h.indexOf('4 new')).toBeGreaterThan(h.indexOf('See you then'));
    expect(h).not.toContain('data-count-badge');
    expect(h).not.toContain('data-tile');
    expect(h).not.toContain('data-row=""');
  });

  it('no message yet: line 2 stays reserved (min-h-9), the card keeps its height', () => {
    const h = card(dm, undefined);
    expect(classOf(h, 'data-list-card-preview=""')).toContain('min-h-9');
    expect(h).toContain(`data-preview-empty="" aria-hidden="true">${EMPTY_PREVIEW}<`);
    expect(EMPTY_PREVIEW.trim()).toBe('');
    expect(EMPTY_PREVIEW.length).toBe(1);
  });

  it('card structure holds across states: read, unread, empty, menu, selecting', () => {
    const base = card(dm, read);
    for (const h of [
      card(dm, { ...read, unread: 9 }),
      card(dm, undefined),
      card(dm, read, { menu: true }),
      card(dm, read, { selecting: true }),
    ]) {
      for (const attr of ['data-list-card-body=""', 'data-list-card-preview=""']) {
        expect(classOf(h, attr)).toEqual(classOf(base, attr));
      }
    }
    // Select mode: the check sits where the ⋯ sits.
    expect(card(dm, read, { selecting: true })).toMatch(
      /data-list-card-more=""[^>]*>[^]*?data-select-check="off"/,
    );
  });

  it('the trailing ⋯ is ActionMenuTrigger with TRAILING_PULL, a sibling of the tap surface', () => {
    const h = card(dm, read, { menu: true });
    expect(TRAILING_PULL).toBe('-mr-3');
    expect(h).toMatch(new RegExp(`aria-label="Actions for Asha Rao"[^>]*${TRAILING_PULL}`));
    const tap = h.indexOf('aria-label="Open Asha Rao');
    expect(h.slice(tap, h.indexOf('data-list-card-more'))).toContain('</button>');
  });

  it('cards stack 12 apart with no dividers', () => {
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
    expect(classOf(html, 'data-section="people"')).toContain('gap-3');
  });
});

describe('notes, groups and people: one card style', () => {
  it('the notes card draws the same frame as a chat card, with the notes icon picture', () => {
    const h = renderToStaticMarkup(
      notesTile({ notes, selected: false, selecting: false, onSelect: () => {} }),
    );
    const chat = card(group, read);
    for (const attr of [
      'data-list-card=""',
      'data-list-card-body=""',
      'data-list-card-preview=""',
    ]) {
      expect(classOf(h, attr)).toEqual(classOf(chat, attr));
    }
    expect(h).toContain('data-list-card-picture="icon"');
    expect(h).toMatch(/<button[^>]*data-notes-tile=""/);
  });

  it('the loading shell is ListCardBox only (no Tile, no Row)', () => {
    const tree = channelListSkeleton();
    expect(findAll(tree, (el) => el.type === Tile)).toHaveLength(0);
    expect(findAll(tree, (el) => el.type === Row)).toHaveLength(0);
    expect(findAll(tree, (el) => el.type === ListCardBox).length).toBeGreaterThan(0);
  });

  it('ChannelList never imports ui/Tile or ui/Row', () => {
    const path = resolve(process.cwd(), 'src/components/chat/ChannelList.tsx');
    const src = readFileSync(path, 'utf8');
    expect(src).not.toContain("from '@/components/ui/Tile'");
    expect(src).not.toContain("from '@/components/ui/Row'");
  });
});
