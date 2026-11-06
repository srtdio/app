// X7 design 1 (H5) and FT43/FT44: every chat tile has a visible 44px ⋯ that
// opens the long-press menu; Hide is non-destructive ("Hide", "Couldn't
// hide"); the tile's accessible name carries unread, preview and time.
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
  ROW_MORE_INK,
  chatRowMenuItems,
  channelTileLabel,
} from '@/components/chat/ChannelList';
import { deleteChatFailedMessage } from '@/lib/chat/clear-flow';
import { IconEyeOff } from '@/components/ui/icons';
import type { ChannelSummary } from '@/lib/chat-reads';

const source = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

const group = {
  channelId: 'g1',
  title: 'Launch',
  channelType: 'group',
} as unknown as ChannelSummary;

describe('X7 H5: the row ⋯', () => {
  it('row ⋯ opens actions: shown on touch too (no hover needed), 44px, fg-3', () => {
    const out = renderToStaticMarkup(
      <ChannelCard
        channel={group}
        selected={false}
        summary={undefined}
        nowMs={0}
        timeZone="UTC"
        onSelect={() => {}}
        input={{ ...DEFAULT_LIST_INPUT, hoverMenu: false, coarsePointer: true }}
        onLongPress={() => {}}
      />,
    );
    // The Row's trailing slot holds the ActionMenuTrigger (a 44 IconButton).
    expect(out).toContain('data-row-more=""');
    expect(out).toContain('aria-label="Actions for Launch"');
    expect(out).toContain('aria-haspopup="menu"');
    expect(out).toMatch(/aria-label="Actions for Launch"[^>]*h-11 w-11/);
    expect(ROW_MORE_INK).toContain('text-fg-3');
    expect(ROW_MORE_INK).not.toContain('opacity-0');
  });

  it('no menu wiring (no hide action): no ⋯', () => {
    const out = renderToStaticMarkup(
      <ChannelCard
        channel={group}
        selected={false}
        summary={undefined}
        nowMs={0}
        timeZone="UTC"
        onSelect={() => {}}
        input={DEFAULT_LIST_INPUT}
      />,
    );
    expect(out).not.toContain('data-row-more');
  });

  it('the ⋯ is a sibling of the tap surface, its glyph on the 12 chat edge (the trailing rule)', () => {
    const out = renderToStaticMarkup(
      <ChannelCard
        channel={group}
        selected={false}
        summary={undefined}
        nowMs={0}
        timeZone="UTC"
        onSelect={() => {}}
        input={DEFAULT_LIST_INPUT}
        onLongPress={() => {}}
      />,
    );
    // Row slot pr-3 (chat gutter), trigger pulled -mr-3: the 20 glyph's edge sits on 12.
    expect(out).toMatch(/data-row-more=""[^>]*pr-3/);
    expect(out).toMatch(/aria-label="Actions for Launch"[^>]*-mr-3/);
  });
});

describe('X7 FT43: Hide is not a destructive action', () => {
  it('menu and bar use the eye-off icon, no danger red, no trash', () => {
    const list = source('../ChannelList.tsx');
    const items = chatRowMenuItems(() => {});
    expect(items.map((i) => i.label)).toEqual(['Hide chat']);
    expect(items[0]?.icon).toBe(IconEyeOff);
    expect(items[0]?.tone).toBeUndefined();
    expect(list).not.toContain('IconTrash');
    const confirm = list.slice(list.indexOf('export function deleteChatsConfirm('));
    expect(confirm.slice(0, confirm.indexOf('export function ChannelList('))).not.toContain(
      'destructive',
    );
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
