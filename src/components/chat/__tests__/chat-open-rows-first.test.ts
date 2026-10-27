import { describe, expect, it, vi } from 'vitest';

// The component's import graph pulls the agora-chat browser SDK; mock it so the
// pure helpers import in node (as ChatConnected.test.tsx does).
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import type { Result } from '@srtdio/rpc';
import { chatThreadLoading, earlyDeepLinkOpen } from '@/components/chat/ChatConnected';
import { openHoldSettled } from '@/components/chat/MessageThread';
import type { ChatOpenBundle, ChatOpenBundleInput } from '@/lib/chat/history';
import { createOpenCache, type ChatKey } from '@/lib/chat/open-cache';
import {
  joinChatBundle,
  joinableChatBundle,
  startChatBundle,
  type ChatBundleDeps,
} from '@/lib/chat/open-bundle';
import { sharedChatRead } from '@/lib/chat/workspace-reads';

const READY = {
  threadCurrent: true,
  notesFailed: false,
  pageLoading: false,
  namesReady: true,
  scheduledSettled: true,
  notesOpen: false,
  notesStatusReady: false,
  notesReady: false,
  savedReady: true,
};

describe('B: stars are off the first-paint gate', () => {
  it('rows paint with every other part in, stars pending or not', () => {
    // Stars are not an input: a pending stars read cannot hold the rows.
    expect(chatThreadLoading(READY)).toBe(false);
  });

  it('every other condition still holds the skeleton', () => {
    expect(chatThreadLoading({ ...READY, threadCurrent: false })).toBe(true);
    expect(chatThreadLoading({ ...READY, pageLoading: true })).toBe(true);
    expect(chatThreadLoading({ ...READY, namesReady: false })).toBe(true);
    expect(chatThreadLoading({ ...READY, scheduledSettled: false })).toBe(true);
    expect(chatThreadLoading({ ...READY, notesOpen: true })).toBe(true);
    expect(chatThreadLoading({ ...READY, notesReady: true, savedReady: false })).toBe(true);
    // Notes whose ensure failed show Retry, never the skeleton.
    expect(chatThreadLoading({ ...READY, notesFailed: true, pageLoading: true })).toBe(false);
  });
});

describe('C: a deep link starts the open from the URL', () => {
  const base = {
    channelParam: 'c1',
    selectedChannelId: null,
    notesChannelId: 'notes-u1',
    loadStatus: 'loading' as const,
    started: null,
  };

  it('kicks off before the list is ready', () => {
    expect(earlyDeepLinkOpen(base)).toBe('c1');
  });

  it('once per link; never for notes, a selection, a ready or failed list, or no link', () => {
    expect(earlyDeepLinkOpen({ ...base, started: 'c1' })).toBeNull();
    expect(earlyDeepLinkOpen({ ...base, started: 'c0' })).toBe('c1');
    expect(earlyDeepLinkOpen({ ...base, channelParam: 'notes-u1' })).toBeNull();
    expect(earlyDeepLinkOpen({ ...base, selectedChannelId: 'c0' })).toBeNull();
    expect(earlyDeepLinkOpen({ ...base, loadStatus: 'ready' })).toBeNull();
    expect(earlyDeepLinkOpen({ ...base, loadStatus: 'error' })).toBeNull();
    expect(earlyDeepLinkOpen({ ...base, channelParam: null })).toBeNull();
    expect(earlyDeepLinkOpen({ ...base, channelParam: '' })).toBeNull();
  });

  it('an early bundle for a chat the list hides is never applied to another chat', async () => {
    const store = createOpenCache();
    const asked: ChatOpenBundleInput[] = [];
    const deps: ChatBundleDeps = {
      store,
      read: (input: ChatOpenBundleInput): Promise<Result<ChatOpenBundle>> => {
        asked.push(input);
        return Promise.resolve({
          ok: false,
          error: { code: 'unknown', message: 'workspace_member_only' },
        });
      },
      share: sharedChatRead,
      traceId: () => '0190a000-0000-7000-8000-0000000000aa',
    };
    const hidden: ChatKey = { userId: 'u1', workspaceId: 'w1', channelId: 'hidden' };
    const other: ChatKey = { userId: 'u1', workspaceId: 'w1', channelId: 'c2' };
    const early = startChatBundle(hidden, { deps });
    // The stash is keyed by the chat: the next chat's thread joins its own call.
    expect(joinableChatBundle(other, store)).toBeNull();
    const next = joinChatBundle(other, { deps });
    expect(next).not.toBe(early);
    await Promise.all([early, next]);
    expect(asked.map((a) => a.channelId)).toEqual(['hidden', 'c2']);
  });
});

describe('D: tasks stay in the open hold', () => {
  it('a pending task list still holds the first page', () => {
    // Task lines insert between rows at times only their read knows, so no
    // row can reserve their height before data: the hold keeps them.
    expect(
      openHoldSettled({ marks: true, side: true, ticker: true, cards: true, tasks: false }),
    ).toBe(false);
    expect(
      openHoldSettled({ marks: true, side: true, ticker: true, cards: true, tasks: true }),
    ).toBe(true);
  });
});
