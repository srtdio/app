import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  PRIVATE_REPLY_KINDS,
  REPLY_PRIVATELY,
  parsePrivateReply,
  parsePrivateReplyDraft,
  privateReplyHeader,
  privateReplyLine,
  privateReplyToRow,
  replyPrivatelyTo,
  type PrivateReplyDraft,
  type PrivateReplyRow,
} from '@/lib/chat/private-reply';

const AUTHOR = '0190a000-0000-7000-8000-000000000003';
const CHANNEL = 'group__0190a000-0000-7000-8000-00000000a001__0190a000-0000-7000-8000-00000000c001';
const MESSAGE = '0190b000-0000-7000-8200-000000000007';
const POST = '0190c000-0000-7000-8000-000000000001';
const COMMENT = '0190f200-0000-7000-8000-0000000000c1';
const PLAN = '0190d000-0000-7000-8000-00000000d001';
const ITEM = '0190d100-0000-7000-8000-00000000d101';
const PLAN_COMMENT = '0190d300-0000-7000-8000-00000000d301';

/** A copy of `value` without `key` (a wire value missing one field). */
function without(value: object, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));
}

const chatRow: PrivateReplyRow = {
  kind: 'chat',
  source_id: MESSAGE,
  author_user_id: AUTHOR,
  excerpt: 'Can we tighten the hook?',
  where_label: 'Launch crew',
  source_created_at: '2026-10-21T08:00:00Z',
  link: { channel_id: CHANNEL, message_id: MESSAGE },
};

const commentRow: PrivateReplyRow = {
  kind: 'comment',
  source_id: COMMENT,
  author_user_id: AUTHOR,
  excerpt: 'Swap the cover',
  where_label: 'Monday carousel',
  source_created_at: '2026-10-21T08:00:00Z',
  link: { entity_type: 'post', entity_id: POST, comment_id: COMMENT },
};

const planRow: PrivateReplyRow = {
  kind: 'plan_comment',
  source_id: PLAN_COMMENT,
  author_user_id: AUTHOR,
  excerpt: 'Moodboard is up.',
  where_label: 'Season opening reel',
  source_created_at: null,
  link: { plan_id: PLAN, item_id: ITEM, comment_id: PLAN_COMMENT },
};

describe('parsePrivateReply', () => {
  it('reads a chat quote', () => {
    expect(parsePrivateReply(chatRow)).toEqual({
      kind: 'chat',
      sourceId: MESSAGE,
      authorUserId: AUTHOR,
      excerpt: 'Can we tighten the hook?',
      whereLabel: 'Launch crew',
      sourceCreatedAt: '2026-10-21T08:00:00Z',
      link: { kind: 'chat', channelId: CHANNEL, messageId: MESSAGE },
    });
  });

  it('reads a post or brief comment quote', () => {
    expect(parsePrivateReply(commentRow)).toEqual({
      kind: 'comment',
      sourceId: COMMENT,
      authorUserId: AUTHOR,
      excerpt: 'Swap the cover',
      whereLabel: 'Monday carousel',
      sourceCreatedAt: '2026-10-21T08:00:00Z',
      link: { kind: 'comment', entityType: 'post', entityId: POST, commentId: COMMENT },
    });
  });

  it('reads a plan comment quote', () => {
    expect(parsePrivateReply(planRow)).toEqual({
      kind: 'plan_comment',
      sourceId: PLAN_COMMENT,
      authorUserId: AUTHOR,
      excerpt: 'Moodboard is up.',
      whereLabel: 'Season opening reel',
      sourceCreatedAt: null,
      link: { kind: 'plan_comment', planId: PLAN, itemId: ITEM, commentId: PLAN_COMMENT },
    });
  });

  it('a missing source_created_at reads as null', () => {
    expect(parsePrivateReply(without(chatRow, 'source_created_at'))?.sourceCreatedAt).toBeNull();
  });

  it('null and undefined are none', () => {
    expect(parsePrivateReply(null)).toBeNull();
    expect(parsePrivateReply(undefined)).toBeNull();
  });

  it('an unknown kind throws', () => {
    expect(() => parsePrivateReply({ ...chatRow, kind: 'dm' })).toThrow(ZodError);
  });

  it('a missing link throws', () => {
    expect(() => parsePrivateReply(without(chatRow, 'link'))).toThrow(ZodError);
  });

  it('a link with an empty id throws', () => {
    expect(() =>
      parsePrivateReply({ ...chatRow, link: { channel_id: '', message_id: MESSAGE } }),
    ).toThrow(ZodError);
  });

  it('a missing author or source throws', () => {
    expect(() => parsePrivateReply({ ...chatRow, author_user_id: '' })).toThrow(ZodError);
    expect(() => parsePrivateReply({ ...chatRow, source_id: undefined })).toThrow(ZodError);
  });

  it('a non-object throws', () => {
    expect(() => parsePrivateReply('chat')).toThrow(ZodError);
    expect(() => parsePrivateReply(42)).toThrow(ZodError);
  });

  it('a link that does not match its kind throws', () => {
    expect(() => parsePrivateReply({ ...chatRow, link: commentRow.link })).toThrow(
      /link does not match kind chat/,
    );
    expect(() => parsePrivateReply({ ...commentRow, link: planRow.link })).toThrow(
      /link does not match kind comment/,
    );
    expect(() => parsePrivateReply({ ...planRow, link: chatRow.link })).toThrow(
      /link does not match kind plan_comment/,
    );
  });
});

describe('privateReplyToRow', () => {
  it('round-trips every kind', () => {
    for (const row of [chatRow, commentRow, planRow]) {
      const parsed = parsePrivateReply(row);
      if (parsed === null) throw new Error('expected a quote');
      expect(privateReplyToRow(parsed)).toEqual(row);
      expect(parsePrivateReply(privateReplyToRow(parsed))).toEqual(parsed);
    }
  });

  it('a missing source_created_at comes back as null', () => {
    const parsed = parsePrivateReply(without(chatRow, 'source_created_at'));
    if (parsed === null) throw new Error('expected a quote');
    expect(privateReplyToRow(parsed).source_created_at).toBeNull();
  });
});

describe('parsePrivateReplyDraft', () => {
  const draft: PrivateReplyDraft = {
    kind: 'chat',
    sourceId: MESSAGE,
    authorUserId: AUTHOR,
    authorName: 'Leo Martins',
    excerpt: 'Can we tighten the hook?',
    whereLabel: 'Launch crew',
    link: { kind: 'chat', channelId: CHANNEL, messageId: MESSAGE },
  };

  it('reads a full quote back (JSON round trip)', () => {
    expect(parsePrivateReplyDraft(JSON.parse(JSON.stringify(draft)))).toEqual(draft);
  });

  it('reads each kind', () => {
    const comment: PrivateReplyDraft = {
      ...draft,
      kind: 'comment',
      link: { kind: 'comment', entityType: 'brief', entityId: POST, commentId: COMMENT },
    };
    const plan: PrivateReplyDraft = {
      ...draft,
      kind: 'plan_comment',
      link: { kind: 'plan_comment', planId: PLAN, itemId: ITEM, commentId: PLAN_COMMENT },
    };
    expect(parsePrivateReplyDraft(comment)).toEqual(comment);
    expect(parsePrivateReplyDraft(plan)).toEqual(plan);
  });

  it('anything not a full quote is none', () => {
    expect(parsePrivateReplyDraft(null)).toBeNull();
    expect(parsePrivateReplyDraft(undefined)).toBeNull();
    expect(parsePrivateReplyDraft('quote')).toBeNull();
    expect(parsePrivateReplyDraft({ ...draft, kind: 'dm' })).toBeNull();
    expect(parsePrivateReplyDraft({ ...draft, authorName: 3 })).toBeNull();
    expect(parsePrivateReplyDraft({ ...draft, excerpt: null })).toBeNull();
    expect(parsePrivateReplyDraft({ ...draft, link: null })).toBeNull();
    expect(
      parsePrivateReplyDraft({ ...draft, link: { ...draft.link, kind: 'comment' } }),
    ).toBeNull();
    expect(parsePrivateReplyDraft(without(draft, 'whereLabel'))).toBeNull();
  });
});

describe('privateReplyHeader and line', () => {
  it('"<Full name> · <where>", the name alone when there is no where', () => {
    expect(privateReplyHeader('Leo Martins', 'Launch crew')).toBe('Leo Martins · Launch crew');
    expect(privateReplyHeader('Leo Martins', '')).toBe('Leo Martins');
  });

  it('folds the excerpt onto one line', () => {
    expect(privateReplyLine('  one\ntwo\n\n three  ')).toBe('one two three');
  });
});

describe('copy', () => {
  it('Reply privately and "to <first name>"', () => {
    expect(REPLY_PRIVATELY).toBe('Reply privately');
    expect(replyPrivatelyTo('Leo')).toBe('to Leo');
    expect(PRIVATE_REPLY_KINDS).toEqual(['chat', 'comment', 'plan_comment']);
  });
});
