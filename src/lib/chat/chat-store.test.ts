import { describe, expect, it } from 'vitest';
import {
  applyIncoming,
  clearPendingOpen,
  initialState,
  markRead,
  mergeInitial,
  requestOpen,
  selectConversation,
  selectTotalUnread,
  setActive,
  updateOwnMessage,
  type ChatStoreState,
} from '@/lib/chat/chat-store';

/** A store seeded with two known channels, each with one unread message. */
function seeded(): ChatStoreState {
  return mergeInitial(
    [{ channelId: 'a' }, { channelId: 'b' }],
    [
      { channelId: 'a', lastMessageText: 'hi a', lastMessageTs: 10, unread: 1 },
      { channelId: 'b', lastMessageText: 'hi b', lastMessageTs: 20, unread: 2 },
    ],
  );
}

describe('mergeInitial', () => {
  it('keys summaries by channel_id and leaves message-less channels at unread 0', () => {
    const state = mergeInitial(
      [{ channelId: 'a' }, { channelId: 'silent' }],
      [{ channelId: 'a', lastMessageText: 'hi', lastMessageTs: 5, unread: 3 }],
    );

    expect(selectConversation(state, 'a')).toEqual({
      lastMessageText: 'hi',
      lastMessageTs: 5,
      unread: 3,
    });
    expect(selectConversation(state, 'silent')).toEqual({
      lastMessageText: '',
      lastMessageTs: 0,
      unread: 0,
    });
  });
});

describe('applyIncoming', () => {
  it('increments unread and updates the last message + ts on a non-active conversation', () => {
    const next = applyIncoming(seeded(), {
      channelId: 'a',
      senderIsSelf: false,
      text: 'new a',
      ts: 30,
    });

    const convo = selectConversation(next, 'a');
    expect(convo?.unread).toBe(2);
    expect(convo?.lastMessageText).toBe('new a');
    expect(convo?.lastMessageTs).toBe(30);
  });

  it('does not increment the active conversation and keeps it read, but updates the line', () => {
    const active = setActive(markRead(seeded(), 'a'), 'a');
    const next = applyIncoming(active, {
      channelId: 'a',
      senderIsSelf: false,
      text: 'while open',
      ts: 40,
    });

    const convo = selectConversation(next, 'a');
    expect(convo?.unread).toBe(0);
    expect(convo?.lastMessageText).toBe('while open');
  });

  it('ignores a self-sent incoming message (no increment, no change)', () => {
    const state = seeded();
    const next = applyIncoming(state, {
      channelId: 'a',
      senderIsSelf: true,
      text: 'echo',
      ts: 50,
    });

    expect(next).toBe(state);
    expect(selectConversation(next, 'a')?.unread).toBe(1);
  });
});

describe('updateOwnMessage', () => {
  it("sets the last message with the 'You' prefix and does not change unread", () => {
    const next = updateOwnMessage(seeded(), { channelId: 'b', text: 'sent', ts: 60 });

    const convo = selectConversation(next, 'b');
    expect(convo?.lastMessageText).toBe('sent');
    expect(convo?.lastMessagePrefix).toBe('You');
    expect(convo?.unread).toBe(2);
  });
});

describe('selectTotalUnread', () => {
  it('equals the sum of unread across conversations', () => {
    expect(selectTotalUnread(seeded())).toBe(3);
    expect(selectTotalUnread(initialState())).toBe(0);
  });
});

describe('markRead', () => {
  it('zeroes one conversation and lowers the total unread', () => {
    const next = markRead(seeded(), 'b');

    expect(selectConversation(next, 'b')?.unread).toBe(0);
    expect(selectTotalUnread(next)).toBe(1);
  });
});

describe('setActive then applyIncoming', () => {
  it('increments again after the active conversation is cleared', () => {
    const cleared = setActive(seeded(), null);
    const next = applyIncoming(cleared, {
      channelId: 'a',
      senderIsSelf: false,
      text: 'back',
      ts: 70,
    });

    expect(selectConversation(next, 'a')?.unread).toBe(2);
  });
});

describe('pending open', () => {
  it('records and clears a requested open', () => {
    const requested = requestOpen(initialState(), 'a');
    expect(requested.pendingOpenConversationId).toBe('a');
    expect(clearPendingOpen(requested).pendingOpenConversationId).toBeNull();
  });
});
