// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatConnection } from '@/lib/chat/types';
import type { ChannelTarget } from '@/lib/chat/thread';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/chat/message-factory', () => ({
  createCmdMessage: (options: Record<string, unknown>) => ({ ...options }),
}));

import { useChatTyping } from '@/lib/chat/use-chat-typing';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

const TARGET: ChannelTarget = { targetId: 'peer', chatType: 'singleChat' };

describe('useChatTyping notifyTyping (FRONTEND-3, FRONTEND-7)', () => {
  it('a send rejected while the socket is down never reaches unhandledrejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    // The SDK rejects with a plain object, not an Error.
    const send = vi.fn(() =>
      Promise.reject({ type: 510, message: 'websocket disconnected', data: {} }),
    );
    const client = {
      send,
      addEventHandler: vi.fn(),
      removeEventHandler: vi.fn(),
      open: vi.fn(),
      close: vi.fn(),
      renewToken: vi.fn(),
    } as unknown as ChatConnection;
    let notify: (() => void) | null = null;
    function Probe(): ReactElement {
      notify = useChatTyping({
        client,
        target: TARGET,
        channelId: 'ch-1',
        currentUserId: 'me',
      }).notifyTyping;
      return <output />;
    }
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root?.render(<Probe />));

    act(() => notify?.());
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    process.off('unhandledRejection', onUnhandled);

    expect(send).toHaveBeenCalledTimes(1);
    expect(unhandled).toEqual([]);
  });
});
