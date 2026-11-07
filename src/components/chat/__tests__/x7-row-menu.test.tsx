// X7 (H5, FT43, FT44), on the new list card: a chat tile has no ⋮ (its one
// action, Hide chat, lives on the select bar a long-press opens); Hide is
// non-destructive ("Hide chat", "Couldn't hide"); the tile's accessible name
// carries unread, preview and time.
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// The chat modules' import graph pulls the agora-chat browser SDK; mock it.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: 'w1', workspaceKey: 'w1', workspaces: [] }),
}));
vi.mock('@/lib/session-context', () => ({
  useSession: () => ({ session: { user: { id: 'me' } }, loading: false }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  ChannelCard,
  DEFAULT_LIST_INPUT,
  chatSelectActions,
  channelTileLabel,
  type ChannelSelectMode,
} from '@/components/chat/ChannelList';
import { deleteChatFailedMessage } from '@/lib/chat/clear-flow';
import { IconEyeOff, IconTrash } from '@/components/ui/icons';
import type { ChannelSummary } from '@/lib/chat-reads';

const source = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

const group = {
  channelId: 'g1',
  title: 'Launch',
  channelType: 'group',
} as unknown as ChannelSummary;

function card(selecting: boolean): string {
  return renderToStaticMarkup(
    <ChannelCard
      channel={group}
      selected={false}
      summary={undefined}
      nowMs={0}
      timeZone="UTC"
      onSelect={() => {}}
      input={{ ...DEFAULT_LIST_INPUT, coarsePointer: true }}
      select={{ active: selecting, chosen: false, onEnter: () => {}, onToggle: () => {} }}
    />,
  );
}

describe('X7 H5, new card: no row ⋯, long-press selects', () => {
  it('a chat card carries no ⋯ and no menu, in or out of select mode', () => {
    for (const out of [card(false), card(true)]) {
      expect(out).not.toContain('data-list-card-more');
      expect(out).not.toContain('Actions for Launch');
      expect(out).not.toContain('aria-haspopup="menu"');
      expect(out.match(/<button/g)).toHaveLength(1);
    }
    // ListCard draws the select tick on the picture once select mode is on.
    expect(card(true)).toContain('data-list-card-tick="off"');
  });

  it('the list wires no row menu of its own', () => {
    const list = source('../ChannelList.tsx');
    expect(list).not.toContain('ActionMenu');
    expect(list).not.toContain('useLongPress');
    expect(list).not.toContain('chatRowMenuItems');
  });
});

describe('X7 FT43: Hide chat is not a destructive action', () => {
  const mode = (over: Partial<ChannelSelectMode> = {}): ChannelSelectMode => ({
    active: true,
    selectedIds: new Set(['g1']),
    onEnter: () => {},
    onStart: () => {},
    onCancel: () => {},
    onToggle: () => {},
    onDelete: () => {},
    ...over,
  });

  it('the bar uses the eye-off icon, no danger red, no trash; Delete for me only in a chip view', () => {
    const items = chatSelectActions(mode());
    expect(items.map((i) => i.label)).toEqual(['Hide chat']);
    expect(items[0]?.icon).toBe(IconEyeOff);
    expect(items[0]?.bad).toBeUndefined();
    // The only trash is the chip view's "Delete for me" (a real delete), never Hide.
    const media = chatSelectActions(mode({ media: { onForward: () => {} } }));
    expect(media.map((i) => i.label)).toEqual(['Forward', 'Delete for me']);
    expect(media.find((i) => i.label === 'Delete for me')?.icon).toBe(IconTrash);
    expect(media.map((i) => i.label)).not.toContain('Hide chat');
    // No confirm at all: Hide runs behind the Undo toast.
    const list = source('../ChannelList.tsx');
    expect(list).not.toContain('ConfirmDialog');
    expect(list).toContain('useUndoableAction');
  });

  it('the failure toast reads "Couldn\'t hide"', () => {
    expect(deleteChatFailedMessage('Launch')).toBe("Couldn't hide Launch. Try again.");
  });
});

describe('X7 FT44: the tile names what it shows', () => {
  it('count, unread, preview and time', () => {
    expect(
      channelTileLabel({ title: 'Launch', unread: 3, preview: 'Asha: see you', time: '10:42' }),
    ).toBe('Open Launch, 3 unread, Asha: see you, 10:42');
    expect(channelTileLabel({ title: 'Launch', unread: 0, preview: '', time: '' })).toBe(
      'Open Launch',
    );
    expect(
      channelTileLabel({ title: 'Ravi', unread: 0, preview: 'hi', time: 'Mon', draft: 'see you' }),
    ).toBe('Open Ravi, Draft: see you, Mon');
  });
});
