import { describe, expect, it, vi } from 'vitest';
import {
  DELETE_CHATS_BODY,
  deleteChatFailedMessage,
  deleteChatsTitle,
  runClearChannels,
} from '@/lib/chat/clear-flow';

describe('delete chat copy', () => {
  it('titles one and several chats', () => {
    expect(deleteChatsTitle(1)).toBe('Delete this chat?');
    expect(deleteChatsTitle(3)).toBe('Delete 3 chats?');
  });

  it('names the failed chat and says it is for the caller only', () => {
    expect(deleteChatFailedMessage('Design')).toBe("Couldn't hide Design.");
    expect(DELETE_CHATS_BODY).toContain('for you only');
  });
});

describe('runClearChannels', () => {
  const channels = [{ channelId: 'a' }, { channelId: 'b' }, { channelId: 'c' }];

  it('clears every chat in order and applies each local effect', async () => {
    const order: string[] = [];
    const onCleared = vi.fn();
    const result = await runClearChannels({
      channels,
      clear: (id) => {
        order.push(id);
        return Promise.resolve({ ok: true });
      },
      onCleared,
    });
    expect(result).toEqual({ ok: true });
    expect(order).toEqual(['a', 'b', 'c']);
    expect(onCleared).toHaveBeenCalledTimes(3);
  });

  it('stops at the first failure and leaves the rest untouched', async () => {
    const clear = vi.fn((id: string) =>
      Promise.resolve(id === 'b' ? { ok: false as const, message: 'nope' } : { ok: true as const }),
    );
    const onCleared = vi.fn();
    const result = await runClearChannels({ channels, clear, onCleared });
    expect(result).toEqual({ ok: false, failed: { channelId: 'b' }, message: 'nope' });
    expect(clear).toHaveBeenCalledTimes(2);
    expect(onCleared).toHaveBeenCalledTimes(1);
    expect(onCleared).toHaveBeenCalledWith({ channelId: 'a' });
  });
});
