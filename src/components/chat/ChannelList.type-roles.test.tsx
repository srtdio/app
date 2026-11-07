// @vitest-environment jsdom
// Type roles on the chat home list (one list, no section labels): group and
// person names as the Row heading
// role (one row style for both), the time as meta (12, tabular) and the
// zero state (title lg/600 fg). The list has no search field, so no no-match
// state.
// Pure renders; nothing reads.

import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// ChannelList's import graph pulls the real agora-chat browser SDK; mock it.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { channelListView } from '@/components/chat/ChannelList';
import type { ChannelSummary } from '@/lib/chat-reads';
import type { ConversationSummary } from '@/lib/chat/chat-store';

const NOW = Date.parse('2026-09-28T10:00:00Z');
const SENT = Date.parse('2026-09-28T09:00:00Z');

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
  lastMessageTs: SENT,
  unread: 0,
};

function list(channels: ChannelSummary[]): ReactElement {
  return channelListView({
    channels,
    hasChannels: true,
    selectedChannelId: null,
    onSelect: () => {},
    onNewChat: () => {},
    summaryFor: () => read,
    nowMs: NOW,
    timeZone: 'UTC',
  });
}

/** Render into the document; every element matching `selector` whose trimmed text is `text`. */
function paint(node: ReactElement, selector: string, text: string): HTMLElement[] {
  document.body.innerHTML = renderToStaticMarkup(node);
  const found = [...document.querySelectorAll<HTMLElement>(selector)].filter(
    (e) => (e.textContent ?? '').trim() === text,
  );
  if (found.length === 0) throw new Error(`no ${selector} reading "${text}"`);
  return found;
}

const classes = (el: Element): string[] => el.className.split(/\s+/);

describe('chat list type roles', () => {
  it('one list: no Groups / People section labels', () => {
    for (const text of ['Groups', 'People']) {
      expect(() => paint(list([group, dm]), 'h3', text)).toThrow();
    }
  });

  it('titles: group and person rows both name in the Row heading role (lg/600)', () => {
    const wide = paint(list([group]), 'span', 'Launch').find((e) =>
      e.classList.contains('truncate'),
    );
    expect(classes(wide as Element)).toEqual(
      expect.arrayContaining(['truncate', 'text-lg', 'font-semibold']),
    );
    const square = paint(list([dm]), 'span', 'Asha Rao').find((e) =>
      e.classList.contains('truncate'),
    );
    expect(classes(square as Element)).toEqual(
      expect.arrayContaining(['truncate', 'text-lg', 'font-semibold']),
    );
    for (const el of [wide, square]) {
      expect((el as Element).className).not.toMatch(/text-\[|leading-\[|font-bold/);
    }
  });

  it('meta: the row time is the meta role (sm, mono, tabular); the preview is secondary', () => {
    // formatAgo on the list's clock: sent an hour before NOW.
    const time = '1h';
    const [stamp] = paint(list([group]), 'span', time);
    expect(classes(stamp as Element)).toEqual(
      expect.arrayContaining(['font-mono', 'text-sm', 'tabular-nums', 'text-fg-3']),
    );
    // Line 2 is the ListCard preview (secondary role, one line).
    const preview = paint(list([group]), 'span', 'See you then').find((e) =>
      e.classList.contains('text-md'),
    );
    expect(classes(preview as Element)).toEqual(
      expect.arrayContaining(['text-md', 'font-normal', 'text-fg-2']),
    );
  });

  it('zero state: names what shows up here (lg/600 fg), no Clear search', () => {
    const [title] = paint(list([]), 'div', 'Chats with your team show up here.');
    expect(classes(title as Element)).toEqual(
      expect.arrayContaining(['text-lg', 'font-semibold', 'text-fg']),
    );
    expect(() => paint(list([]), 'button', 'Clear search')).toThrow();
  });
});
