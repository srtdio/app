// @vitest-environment jsdom
// Type roles on the chat home list: the Groups / People section labels (12,
// 600, uppercase, .06em, fg-2), the tile names as card titles (the chat list
// keeps its chat sizes: 17/600 wide, 15/600 square), the time as meta (12,
// tabular) and the no-match state (title lg/600, description base fg-2).
// Pure renders; nothing reads.

import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// ChannelList's import graph pulls the real agora-chat browser SDK; mock it.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { channelListView } from '@/components/chat/ChannelList';
import { formatRelativeTime } from '@/lib/chat/format-relative-time';
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

function list(channels: ChannelSummary[], search?: string): ReactElement {
  return channelListView({
    channels,
    hasChannels: true,
    selectedChannelId: null,
    onSelect: () => {},
    onNewChat: () => {},
    summaryFor: () => read,
    nowMs: NOW,
    timeZone: 'UTC',
    ...(search !== undefined ? { search } : {}),
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
const SECTION_LABEL = ['text-sm', 'font-semibold', 'uppercase', 'tracking-[0.06em]', 'text-fg-2'];

describe('chat list type roles', () => {
  it('section labels: Groups and People are sm, 600, uppercase, .06em, fg-2', () => {
    for (const text of ['Groups', 'People']) {
      const [label] = paint(list([group, dm]), 'h3', text);
      expect(classes(label as Element)).toEqual(expect.arrayContaining(SECTION_LABEL));
      expect(classes(label as Element)).not.toContain('text-xs');
    }
  });

  it('card titles: the wide tile name is xl/600, the square tile name lg/600', () => {
    const wide = paint(list([group]), 'span', 'Launch').find((e) =>
      e.classList.contains('truncate'),
    );
    expect(classes(wide as Element)).toEqual(
      expect.arrayContaining(['truncate', 'text-fg', 'text-xl', 'font-semibold']),
    );
    const square = paint(list([dm]), 'span', 'Asha Rao').find((e) =>
      e.classList.contains('truncate'),
    );
    expect(classes(square as Element)).toEqual(
      expect.arrayContaining(['truncate', 'text-fg', 'text-lg', 'font-semibold']),
    );
    for (const el of [wide, square]) {
      expect((el as Element).className).not.toMatch(/text-\[|leading-\[|font-bold/);
    }
  });

  it('meta: the tile time is sm with tabular figures; the preview is secondary ink', () => {
    const time = formatRelativeTime(SENT, NOW, 'UTC');
    const [stamp] = paint(list([group]), 'span', time);
    expect(classes(stamp as Element)).toEqual(
      expect.arrayContaining(['text-sm', 'tabular-nums', 'text-fg-2']),
    );
    const [preview] = paint(list([group]), 'span', 'See you then');
    expect(classes(preview as Element)).toEqual(
      expect.arrayContaining(['text-base', 'font-normal', 'text-fg-2']),
    );
  });

  it('no match: the title is lg/600 fg, the description base fg-2', () => {
    const [title] = paint(list([], 'zzz'), 'p', 'No chats called "zzz"');
    expect(classes(title as Element)).toEqual(
      expect.arrayContaining(['text-lg', 'font-semibold', 'text-fg']),
    );
    const [hint] = paint(list([], 'zzz'), 'p', 'Try a different name or clear the search.');
    expect(classes(hint as Element)).toEqual(expect.arrayContaining(['text-base', 'text-fg-2']));
  });
});
