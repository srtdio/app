// W8 regressions for the chat home: "Hide chat" and the notes tile's last note.

import { describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { hiddenChatsLabel, notesLastLine } from '@/components/chat/ChannelList';

describe('W8 fix 7: small fixes', () => {
  it('Hide chat has no confirm: the Undo toast reads "Chat hidden" / "N chats hidden"', () => {
    expect(hiddenChatsLabel(1)).toBe('Chat hidden');
    expect(hiddenChatsLabel(3)).toBe('3 chats hidden');
  });

  it('the notes tile shows the last note and its time', () => {
    const now = Date.parse('2026-06-14T12:00:00.000Z');
    const line = notesLastLine(
      { lastMessageText: 'Buy film', lastMessageTs: now - 5 * 60_000, unread: 0 },
      now,
    );
    expect(line?.preview).toBe('Buy film');
    expect(line?.time).not.toBe('');
    expect(notesLastLine(undefined, now)).toBeNull();
    expect(notesLastLine({ lastMessageText: '', lastMessageTs: 0, unread: 0 }, now)).toBeNull();
  });
});
