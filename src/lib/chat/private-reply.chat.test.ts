import { describe, expect, it } from 'vitest';
import {
  canReplyPrivatelyInChat,
  chatPrivateReplyDraft,
  parseStoredPrivateReply,
  privateReplyFromDraft,
  privateReplyHref,
  type PrivateReply,
} from '@/lib/chat/private-reply';
import { chatMessageHref, planHref } from '@/lib/inbox/bell-types';

const ASHA = '22222222-2222-4222-8222-222222222222';

describe('canReplyPrivatelyInChat (menu visibility)', () => {
  const groupOther = {
    mine: false,
    senderUserId: ASHA,
    isGroup: true,
    notes: false,
    senderRemoved: false,
    state: 'sent' as const,
  };

  it("shows on someone else's recorded message in a group", () => {
    expect(canReplyPrivatelyInChat(groupOther)).toBe(true);
  });

  it('hidden on my own message', () => {
    expect(canReplyPrivatelyInChat({ ...groupOther, mine: true })).toBe(false);
  });

  it('hidden in a DM', () => {
    expect(canReplyPrivatelyInChat({ ...groupOther, isGroup: false })).toBe(false);
  });

  it('hidden in Personal notes', () => {
    expect(canReplyPrivatelyInChat({ ...groupOther, notes: true })).toBe(false);
  });

  it('hidden on a removed or former member', () => {
    expect(canReplyPrivatelyInChat({ ...groupOther, senderRemoved: true })).toBe(false);
  });

  it('hidden with no known sender, on a tombstone, or before it is recorded', () => {
    expect(canReplyPrivatelyInChat({ ...groupOther, senderUserId: null })).toBe(false);
    expect(canReplyPrivatelyInChat({ ...groupOther, deleted: true })).toBe(false);
    expect(canReplyPrivatelyInChat({ ...groupOther, state: 'sending' })).toBe(false);
    expect(canReplyPrivatelyInChat({ ...groupOther, state: 'failed' })).toBe(false);
  });
});

describe('chatPrivateReplyDraft', () => {
  it('quotes the group message, its author, one line of words and the group name', () => {
    expect(
      chatPrivateReplyDraft({
        channelId: 'g1',
        messageId: 'm1',
        authorUserId: ASHA,
        authorName: 'Asha Rao',
        excerpt: 'Can you\nsend it?',
        groupName: 'Launch team',
      }),
    ).toEqual({
      kind: 'chat',
      sourceId: 'm1',
      authorUserId: ASHA,
      authorName: 'Asha Rao',
      excerpt: 'Can you send it?',
      whereLabel: 'Launch team',
      link: { kind: 'chat', channelId: 'g1', messageId: 'm1' },
    });
  });
});

describe('privateReplyHref (bubble quote tap target)', () => {
  it('a chat quote jumps to the group message', () => {
    expect(privateReplyHref({ kind: 'chat', channelId: 'g1', messageId: 'm1' })).toBe(
      chatMessageHref('g1', 'm1'),
    );
  });

  it('a post or brief comment lands on the comment (focus-target via ?comment=)', () => {
    expect(
      privateReplyHref({ kind: 'comment', entityType: 'post', entityId: 'p1', commentId: 'c1' }),
    ).toBe('/posts/p1?comment=c1');
    expect(
      privateReplyHref({ kind: 'comment', entityType: 'brief', entityId: 'b1', commentId: 'c2' }),
    ).toBe('/briefs/b1?comment=c2');
  });

  it('an unknown comment entity has nowhere to go', () => {
    expect(
      privateReplyHref({ kind: 'comment', entityType: 'asset', entityId: 'a1', commentId: 'c1' }),
    ).toBeNull();
  });

  it('a plan comment opens the plan item at the comment (the Activity link)', () => {
    expect(
      privateReplyHref({ kind: 'plan_comment', planId: 'pl1', itemId: 'it1', commentId: 'c3' }),
    ).toBe(`${planHref('pl1', 'it1')}&comment=c3`);
  });
});

describe('parseStoredPrivateReply (the outbox on device)', () => {
  const quote: PrivateReply = privateReplyFromDraft({
    kind: 'plan_comment',
    sourceId: 'c3',
    authorUserId: ASHA,
    authorName: 'Asha Rao',
    excerpt: 'Move it to Friday',
    whereLabel: 'Reel shoot',
    link: { kind: 'plan_comment', planId: 'pl1', itemId: 'it1', commentId: 'c3' },
  });

  it('a JSON round trip reads back', () => {
    expect(parseStoredPrivateReply(JSON.parse(JSON.stringify(quote)))).toEqual(quote);
  });

  it('anything malformed is null, never a throw', () => {
    expect(parseStoredPrivateReply(null)).toBeNull();
    expect(parseStoredPrivateReply('x')).toBeNull();
    expect(parseStoredPrivateReply({ ...quote, link: null })).toBeNull();
    expect(parseStoredPrivateReply({ ...quote, sourceId: '' })).toBeNull();
    expect(parseStoredPrivateReply({ ...quote, kind: 'chat' })).toBeNull();
  });
});
