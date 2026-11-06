// @vitest-environment jsdom
// B-final chat list: Personal notes, Groups and People are one row style, the
// shared ui/Row on the 12 chat edge (CHAT_GUTTER). A person row is a group row:
// a 32 avatar, name + time on line 1, the one-line preview on line 2, the
// unread CountBadge, the ⋯ through ActionMenuTrigger (TRAILING_PULL), the
// divider inset to the text. A DM with no message keeps line 2 reserved, so
// the row stays 72. No ui/Tile anywhere in the list.
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
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

/** The tap surface's class list (the PressableRow inside the Row). */
function surfaceClass(html: string): string {
  const m = html.match(/<button[^>]*aria-label="Open [^"]*"[^>]*class="([^"]*)"/);
  const n = html.match(/<button[^>]*class="([^"]*)"[^>]*aria-label="Open [^"]*"/);
  return m?.[1] ?? n?.[1] ?? '';
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

describe('people rows are ui/Row, exactly like group rows', () => {
  it('a person and a group draw the same surface: 72 tall, chat edge, gap 12', () => {
    const person = surfaceClass(card(dm, read));
    const grp = surfaceClass(card(group, read));
    expect(person).not.toBe('');
    expect(person).toBe(grp);
    for (const cls of ['min-h-18', 'px-3', 'gap-3']) expect(person.split(' ')).toContain(cls);
  });

  it('slots: 32 avatar, name heading + time meta on line 1, preview secondary on line 2', () => {
    const h = card(dm, { ...read, unread: 4 });
    expect(h).toContain('data-chat-list-item="row"');
    expect(h).toMatch(/data-row-leading=""[^>]*w-8/);
    expect(h).toContain('data-avatar-role="header"');
    expect(h).toContain('width:32px;height:32px');
    expect(h).toMatch(/text-lg font-semibold[^"]*">Asha Rao</);
    expect(h).toMatch(/font-mono[^"]*">[^<]+</);
    expect(h).toMatch(/text-md[^"]*"><span>See you then</);
    // The unread CountBadge rides the second line, after the preview.
    expect(h.indexOf('data-count-badge')).toBeGreaterThan(h.indexOf('See you then'));
    expect(h).not.toContain('data-tile');
  });

  it('no message yet: line 2 is reserved and empty, the row stays 72 (no collapse)', () => {
    const h = card(dm, undefined);
    expect(surfaceClass(h).split(' ')).toContain('min-h-18');
    expect(h).toContain(`data-preview-empty="" aria-hidden="true">${EMPTY_PREVIEW}<`);
    expect(EMPTY_PREVIEW.trim()).toBe('');
    expect(EMPTY_PREVIEW.length).toBe(1);
  });

  it('row height holds across states: read, unread, empty, menu, selecting', () => {
    for (const h of [
      card(dm, read),
      card(dm, { ...read, unread: 9 }),
      card(dm, undefined),
      card(dm, read, { menu: true }),
      card(dm, read, { selecting: true }),
    ]) {
      expect(surfaceClass(h).split(' ')).toContain('min-h-18');
    }
  });

  it('the trailing ⋯ is ActionMenuTrigger with TRAILING_PULL, a sibling of the tap surface', () => {
    const h = card(dm, read, { menu: true });
    expect(TRAILING_PULL).toBe('-mr-3');
    expect(h).toMatch(/data-row-more=""[^>]*pr-3/);
    expect(h).toMatch(new RegExp(`aria-label="Actions for Asha Rao"[^>]*${TRAILING_PULL}`));
    const tap = h.indexOf('aria-label="Open Asha Rao');
    expect(h.slice(tap, h.indexOf('data-row-more'))).toContain('</button>');
  });

  it('dividers sit between people rows, inset to the text (56)', () => {
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
    expect(html.match(/data-row-divider=""/g)).toHaveLength(1);
    expect(html).toMatch(/data-row-divider=""[^>]*left-14/);
  });
});

describe('notes, groups and people: one row style', () => {
  it('the notes row draws the same surface as a chat row', () => {
    const h = renderToStaticMarkup(
      notesTile({ notes, selected: false, selecting: false, onSelect: () => {} }),
    );
    const notesSurface = surfaceClass(h).split(' ');
    for (const cls of ['min-h-18', 'px-3', 'gap-3']) expect(notesSurface).toContain(cls);
  });

  it('the loading shell is Rows only (no Tile), on the chat edge', () => {
    const tree = channelListSkeleton();
    expect(findAll(tree, (el) => el.type === Tile)).toHaveLength(0);
    const rows = findAll(tree, (el) => el.type === Row);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect((r.props as { gutter?: string }).gutter).toBe('chat');
  });

  it('ChannelList never imports ui/Tile', () => {
    const path = fileURLToPath(new URL('../ChannelList.tsx', import.meta.url));
    const src = readFileSync(path, 'utf8');
    expect(src).not.toContain("from '@/components/ui/Tile'");
  });
});
