// @vitest-environment jsdom
// B1b: the chat list and the chat headers render through the shared parts.
// Group and people chats are ui/ListCard (60 tall, the 40 picture, no ⋮:
// long-press selects); no chat is a Tile; Thread, Contact, Group
// info and Tasks headers are ui/HeaderBar with one exit (Back "<"
// on the left, never an X), glyphs 20.
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { channelListView } from '@/components/chat/ChannelList';
import { groupInfoPage } from '@/components/chat/GroupInfoSheet';
import { ThreadViewFrame } from '@/components/chat/ThreadView';
import type { ChannelSummary } from '@/lib/chat-reads';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const source = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const base: ChannelSummary = {
  channelId: 'c1',
  channelType: 'dm',
  title: 'Asha Rao',
  avatarUrl: null,
  agoraGroupId: null,
  groupId: null,
  peerUserId: 'u2',
  createdAt: 't',
};
const group = (id: string, title: string): ChannelSummary => ({
  ...base,
  channelId: id,
  channelType: 'group',
  title,
});

function list(): string {
  return renderToStaticMarkup(
    channelListView({
      channels: [group('g1', 'Launch'), group('g2', 'Brand'), base],
      hasChannels: true,
      selectedChannelId: null,
      onSelect: () => {},
      onNewChat: () => {},
      select: { active: false, selectedIds: new Set(), onEnter: () => {}, onToggle: () => {} },
    }),
  );
}

describe('ChannelList on ui/ListCard', () => {
  it('group and people chats render [data-list-card] with the 48 picture (40 Compact), no dividers', () => {
    const out = list();
    expect(out.match(/data-list-card=""/g)).toHaveLength(3);
    expect(out).toMatch(/data-list-card-picture="[a-z]+"[^>]*class="[^"]*h-12 w-12/);
    expect(out).toContain('h-12 w-12');
    expect(out).not.toContain('data-row-divider');
  });

  it('no ⋮ on a chat card: one button per card (long-press selects)', () => {
    const out = list();
    expect(out).not.toContain('Actions for');
    expect(out).not.toContain('data-list-card-more');
    expect(out.match(/<button/g)).toHaveLength(3);
  });

  it('people render [data-list-card] like groups, never [data-tile]', () => {
    const out = list();
    expect(out).not.toContain('data-tile');
    expect(out).toContain('>Asha Rao<');
  });

  it('the onboarding tour still finds the default group card (data-induction on the li)', () => {
    expect(list()).toContain('data-induction-channel="g1"');
  });
});

describe('chat headers on ui/HeaderBar: one exit each', () => {
  let root: Root | null = null;
  const original = (HTMLElement.prototype as { animate?: unknown }).animate;
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = '';
    (HTMLElement.prototype as { animate?: unknown }).animate = original;
  });

  it('Group info: [data-header-bar], one Back "<" on the 16 edge, no X', () => {
    const out = renderToStaticMarkup(
      groupInfoPage({
        onClose: () => {},
        error: null,
        sections: ['hero'],
        nodes: { hero: 'HERO', tabs: null, name: null, members: null, leave: null },
      }),
    );
    expect(out.match(/data-header-bar=""/g)).toHaveLength(1);
    const header = out.slice(out.indexOf('data-header-bar'), out.indexOf('</header>'));
    expect(header.match(/<button/g)).toHaveLength(1);
    expect(header).toMatch(/aria-label="Back"[^>]*-ml-3/);
    expect(header).not.toContain('aria-label="Close"');
  });

  it('Thread: [data-header-bar], Close thread is the one back "<", the focus target kept', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const node: ReactElement = (
      <ThreadViewFrame title="Launch teaser" selecting={false} onClosed={() => {}}>
        <div />
      </ThreadViewFrame>
    );
    (HTMLElement.prototype as { animate?: unknown }).animate = vi.fn(() => ({
      addEventListener: vi.fn(),
      finish: vi.fn(),
      cancel: vi.fn(),
    }));
    act(() => root?.render(node));
    const bar = host.querySelector('[data-header-bar]');
    expect(bar).not.toBeNull();
    const buttons = bar?.querySelectorAll('button') ?? [];
    expect(buttons).toHaveLength(1);
    const close = host.querySelector<HTMLButtonElement>('[data-thread-view-close]');
    expect(close?.getAttribute('aria-label')).toBe('Close thread');
    expect(close?.className).toContain('-ml-3');
    expect(bar?.querySelector('[data-thread-view-title]')?.textContent).toBe('Launch teaser');
  });

  it('Contact and Tasks render the shared bar (Back left, never an X exit)', () => {
    for (const file of ['../ContactSheet.tsx', '../tasks/TaskSheet.tsx']) {
      const text = source(file);
      expect(text).toContain('<HeaderBar');
      expect(text).not.toContain('<IconChevronLeft');
    }
    // Tasks: Back, Tasks, the save state, Share to chat (the bar's last action).
    const tasks = source('../tasks/TaskSheet.tsx');
    const start = tasks.indexOf('<HeaderBar');
    const bar = tasks.slice(start, tasks.indexOf('/>\n        </div>', start));
    expect(bar).toContain("backProps={{ label: BACK_LABEL, 'data-task-back': '' }}");
    expect(bar).not.toContain('<ActionMenu');
    expect(bar.indexOf('data-task-save-slot')).toBeLessThan(bar.indexOf('label={SHARE_LABEL}'));
  });
});
