import { describe, expect, it } from 'vitest';
import {
  applyIncoming,
  applyPreviews,
  applyUnreadCounts,
  clearPendingOpen,
  initialState,
  markRead,
  mergeInitial,
  previewText,
  requestOpen,
  selectConversation,
  selectTotalUnread,
  setActive,
  updateOwnMessage,
  type ChatStoreState,
} from '@/lib/chat/chat-store';

const ME = 'me';

/** A store seeded with two known channels from chat_unread_counts. */
function seeded(): ChatStoreState {
  return applyUnreadCounts(mergeInitial([{ channelId: 'a' }, { channelId: 'b' }]), [
    { channelId: 'a', unread: 1, lastMessageAt: '1970-01-01T00:00:00.010Z' },
    { channelId: 'b', unread: 2, lastMessageAt: '1970-01-01T00:00:00.020Z' },
  ]);
}

describe('mergeInitial + applyUnreadCounts', () => {
  it('keys every roster channel at unread 0 and lets chat_unread_counts drive badges + order', () => {
    const state = applyUnreadCounts(mergeInitial([{ channelId: 'a' }, { channelId: 'silent' }]), [
      { channelId: 'a', unread: 3, lastMessageAt: '1970-01-01T00:00:00.005Z' },
    ]);

    expect(selectConversation(state, 'a')).toEqual({
      lastMessageText: '',
      lastMessageTs: 5,
      unread: 3,
    });
    expect(selectConversation(state, 'silent')).toEqual({
      lastMessageText: '',
      lastMessageTs: 0,
      unread: 0,
    });
    expect(selectTotalUnread(state)).toBe(3);
  });

  it('pins the active conversation at unread 0 on refresh and keeps the preview text', () => {
    const viewing = setActive(
      applyPreviews(
        seeded(),
        [
          {
            channelId: 'a',
            messageId: 'm',
            senderUserId: 'x',
            body: 'hi a',
            hasAttachments: false,
            createdAt: '1970-01-01T00:00:00.010Z',
          },
        ],
        ME,
      ),
      'a',
    );
    const refreshed = applyUnreadCounts(viewing, [
      { channelId: 'a', unread: 5, lastMessageAt: '1970-01-01T00:00:00.030Z' },
    ]);
    expect(selectConversation(refreshed, 'a')).toEqual({
      lastMessageText: 'hi a',
      lastMessageTs: 30,
      unread: 0,
    });
  });
});

describe('applyPreviews / previewText', () => {
  it('sets the line from the record with a You prefix for own sends and an attachment label', () => {
    const state = applyPreviews(
      seeded(),
      [
        {
          channelId: 'a',
          messageId: 'm1',
          senderUserId: ME,
          body: 'sent by me',
          hasAttachments: false,
          createdAt: '1970-01-01T00:00:00.010Z',
        },
        {
          channelId: 'b',
          messageId: 'm2',
          senderUserId: 'x',
          body: '',
          hasAttachments: true,
          createdAt: '1970-01-01T00:00:00.020Z',
        },
      ],
      ME,
    );
    expect(selectConversation(state, 'a')).toEqual({
      lastMessageText: 'sent by me',
      lastMessagePrefix: 'You',
      lastMessageTs: 10,
      unread: 1,
    });
    expect(selectConversation(state, 'b')?.lastMessageText).toBe('Attachment');
    expect(previewText({ body: ' ', hasAttachments: false })).toBe('');
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
