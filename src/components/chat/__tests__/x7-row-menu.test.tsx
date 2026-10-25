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
vi.mock('@/lib/use-media-query', () => ({ useMediaQuery: () => false }));
vi.mock('@/lib/session-context', () => ({
  useSession: () => ({ session: { user: { id: 'me' } }, loading: false }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  ChannelCard,
  DEFAULT_LIST_INPUT,
  channelRowClass,
  channelTileLabel,
  rowMoreClass,
} from '@/components/chat/ChannelList';
import { deleteChatFailedMessage } from '@/lib/chat/clear-flow';
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
    expect(out).toContain('data-row-more=""');
    expect(out).toContain('aria-label="Actions for Launch"');
    expect(out).toContain('aria-haspopup="menu"');
    const cls = rowMoreClass('wide');
    expect(cls).toContain('h-11 w-11');
    expect(cls).toContain('text-fg-3');
    expect(cls).not.toContain('opacity-0');
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

  it('a wide tile leaves room at its right for the ⋯', () => {
    const base = { kind: 'wide' as const, selected: false, selecting: false, checked: false };
    expect(channelRowClass(base)).toContain('pr-4');
    expect(channelRowClass({ ...base, more: true })).toContain('pr-14');
    expect(channelRowClass({ ...base, more: true })).not.toContain('pr-4');
  });
});

describe('X7 FT43: Hide is not a destructive action', () => {
  it('menu and bar use the eye-off icon, no danger red, no trash', () => {
    const list = source('../ChannelList.tsx');
    const menu = list.slice(
      list.indexOf('function ChannelRowMenu('),
      list.indexOf('export function hideChatsTitle'),
    );
    expect(menu).toContain('<IconEyeOff />');
    expect(menu).not.toContain('danger');
    expect(menu).not.toContain('IconTrash');
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
