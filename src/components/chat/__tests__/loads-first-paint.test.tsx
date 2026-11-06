import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { Result } from '@srtdio/rpc';

// The component import graph pulls the agora-chat browser SDK; mock it so the
// pure helpers import in node.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { loadChatList, type ChatListReaders } from '@/components/chat/ChatStoreProvider';
import { channelListError } from '@/components/chat/ChannelList';
import { openingChannelId } from '@/components/chat/ChatConnected';
import { threadLoadError, threadOpeningSkeleton } from '@/components/chat/MessageThread';
import { Button } from '@/components/ui/Button';
import { READ_TIMEOUT_MS } from '@/lib/chat-reads';
import { beginLoad, initialState, type ChatStoreState } from '@/lib/chat/chat-store';

afterEach(() => {
  vi.useRealTimers();
});

function never<T>(): Promise<Result<T>> {
  return new Promise(() => {});
}

function findButton(root: ReactElement): ReactElement<{ onClick: () => void }> | undefined {
  let found: ReactElement<{ onClick: () => void }> | undefined;
  const walk = (node: unknown): void => {
    if (found !== undefined || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    const el = node as ReactElement<Record<string, unknown>>;
    if (el.type === Button) {
      found = el as unknown as ReactElement<{ onClick: () => void }>;
      return;
    }
    walk(el.props?.children);
    walk(el.props?.action);
  };
  walk(root);
  return found;
}

describe('P1: first load never stays loading', () => {
  it('a hung read settles the list as its error + Retry state at 5s', async () => {
    vi.useFakeTimers();
    const readers: ChatListReaders = {
      roster: () => Promise.resolve({ ok: true, data: [] }),
      clears: () => Promise.resolve({ ok: true, data: [] }),
      previews: never,
      counts: () => Promise.resolve({ ok: true, data: [] }),
    };
    let state: ChatStoreState = beginLoad(initialState(), 's');
    expect(state.status).toBe('loading');
    let done = false;
    void loadChatList(readers, 's', 'me').then((transition) => {
      state = transition(state);
      done = true;
    });
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    expect(state.status).toBe('error');
    const retry = vi.fn();
    const html = renderToStaticMarkup(channelListError(retry));
    expect(html).toContain('Retry');
    expect(html).not.toMatch(/offline|connecting|reconnecting/i);
    findButton(channelListError(retry))?.props.onClick();
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

describe('P2: thread history failure shows Retry', () => {
  it('"Couldn\'t load messages" + a 44px Retry, never "No messages yet"', () => {
    const retry = vi.fn();
    const root = threadLoadError(retry);
    const html = renderToStaticMarkup(root);
    expect(html).toMatch(/Couldn.{1,6}t load messages/);
    expect(html).not.toContain('No messages yet');
    expect(html).toContain('min-w-11');
    // Tokens only (chat-tokens.test.ts scans for literals); no connection wording.
    expect(html).not.toMatch(/offline|connecting|reconnecting/i);
    findButton(root)?.props.onClick();
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

describe('P8: opening a chat paints its own skeleton first', () => {
  it('a deep link (or reload in a thread) before the roster is ready is the thread skeleton', () => {
    const opening = openingChannelId({
      selectedChannelId: null,
      channelParam: 'c1',
      pendingOpen: null,
      loadStatus: 'loading',
    });
    expect(opening).toBe('c1');
    const html = renderToStaticMarkup(threadOpeningSkeleton());
    expect(html).toContain('data-thread-opening');
    expect(html).toContain('data-skeleton-bubble');
    expect(html).not.toContain('Select a conversation');
  });

  it('an Activity tap or toast open (pending open) is the thread skeleton too', () => {
    expect(
      openingChannelId({
        selectedChannelId: null,
        channelParam: null,
        pendingOpen: 'c2',
        loadStatus: 'ready',
      }),
    ).toBe('c2');
  });

  it('an unknown or unreadable chat (param stripped) or a failed list is chat home', () => {
    expect(
      openingChannelId({
        selectedChannelId: null,
        channelParam: null,
        pendingOpen: null,
        loadStatus: 'ready',
      }),
    ).toBeNull();
    expect(
      openingChannelId({
        selectedChannelId: null,
        channelParam: 'c1',
        pendingOpen: null,
        loadStatus: 'error',
      }),
    ).toBeNull();
    // Once the chat is selected the real thread renders.
    expect(
      openingChannelId({
        selectedChannelId: 'c1',
        channelParam: 'c1',
        pendingOpen: null,
        loadStatus: 'ready',
      }),
    ).toBeNull();
  });
});
