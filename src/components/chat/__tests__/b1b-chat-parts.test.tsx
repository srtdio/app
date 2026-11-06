// @vitest-environment jsdom
// B1b: the chat list and the chat headers render through the shared parts.
// Group chats are ui/Row (56/72, a 32 avatar column, text at 60, the divider
// inset 60, the ⋯ through the trailing rule); people are ui/Tile (name, the
// time in the meta slot, the ⋯ on the title line); Thread, Contact, Group
// info, Starred and Tasks headers are ui/HeaderBar with one exit (Back "<"
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
      onLongPress: () => {},
      onHide: () => {},
    }),
  );
}

describe('ChannelList on ui/Row and ui/Tile', () => {
  it('group chats render [data-row] with the 32 avatar column and the inset divider', () => {
    const out = list();
    expect(out.match(/data-row=""/g)).toHaveLength(2);
    expect(out).toMatch(/data-row-leading=""[^>]*w-8/);
    expect(out).toContain('width:32px;height:32px');
    // Every row but the last in its section, inset 60.
    expect(out.match(/data-row-divider=""/g)).toHaveLength(1);
    expect(out).toMatch(/data-row-divider=""[^>]*left-15/);
  });

  it('the group ⋯ ends on the row edge: Row slot pr-4, trigger pulled 12 (the trailing rule)', () => {
    const out = list();
    expect(out).toMatch(/data-row-more=""[^>]*pr-4/);
    expect(out).toMatch(/aria-label="Actions for Launch"[^>]*-mr-3/);
  });

  it('people render [data-tile]: the name, the time in the meta slot, the ⋯ on the title line', () => {
    const out = list();
    expect(out.match(/data-tile=""/g)).toHaveLength(1);
    expect(out).toContain('>Asha Rao<');
    expect(out).toMatch(/data-tile-more=""[^>]*>.*aria-label="Actions for Asha Rao"[^>]*-mr-3/);
    expect(out).toContain('data-tile-press=""');
  });

  it('the onboarding tour still finds the default group row (data-induction on the li)', () => {
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

  it('Contact, Starred and Tasks render the shared bar (Back left, never an X exit)', () => {
    for (const file of ['../ContactSheet.tsx', '../StarredList.tsx', '../tasks/TaskSheet.tsx']) {
      const text = source(file);
      expect(text).toContain('<HeaderBar');
      expect(text).not.toContain('<IconChevronLeft');
    }
    // Tasks: Back, Tasks, the save state, ⋯ (the ⋯ is the bar's last action).
    const tasks = source('../tasks/TaskSheet.tsx');
    const start = tasks.indexOf('<HeaderBar');
    const bar = tasks.slice(start, tasks.indexOf('/>\n        </div>', start));
    expect(bar).toContain("backProps={{ label: BACK_LABEL, 'data-task-back': '' }}");
    expect(bar.indexOf('data-task-save-slot')).toBeLessThan(bar.indexOf('<ActionMenu'));
  });
});
