import { describe, expect, it } from 'vitest';
import { FORMER_MEMBER } from '@/lib/chat/mentions';
import {
  canReplyPrivately,
  commentPrivateReplyDraft,
  planCommentPrivateReplyDraft,
} from '@/lib/reply-privately';

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

describe('canReplyPrivately', () => {
  const base = { authorUserId: OTHER, me: ME, authorName: 'Omar Other' };

  it("shows on another known member's comment", () => {
    expect(canReplyPrivately(base)).toBe(true);
  });

  it('hides on my own comment (any case of the id)', () => {
    expect(canReplyPrivately({ ...base, authorUserId: ME })).toBe(false);
    expect(canReplyPrivately({ ...base, authorUserId: ME.toUpperCase() })).toBe(false);
  });

  it('hides while I am unknown', () => {
    expect(canReplyPrivately({ ...base, me: null })).toBe(false);
  });

  it('hides on a legacy author and on no author id', () => {
    expect(canReplyPrivately({ ...base, legacy: true })).toBe(false);
    expect(canReplyPrivately({ ...base, authorUserId: null })).toBe(false);
    expect(canReplyPrivately({ ...base, authorUserId: '' })).toBe(false);
  });

  it('hides on a former member, by flag or by the name the row shows', () => {
    expect(canReplyPrivately({ ...base, former: true })).toBe(false);
    expect(canReplyPrivately({ ...base, authorName: FORMER_MEMBER })).toBe(false);
  });

  it('hides while the name is still unknown', () => {
    expect(canReplyPrivately({ ...base, authorName: '' })).toBe(false);
    expect(canReplyPrivately({ ...base, authorName: '   ' })).toBe(false);
  });
});

describe('private reply drafts', () => {
  it('a post or brief comment quotes its entity link', () => {
    expect(
      commentPrivateReplyDraft({
        commentId: 'c-1',
        authorUserId: OTHER,
        authorName: 'Omar Other',
        excerpt: 'Looks good @mia',
        whereLabel: 'Spring launch',
        entityType: 'post',
        entityId: 'post-1',
      }),
    ).toEqual({
      kind: 'comment',
      sourceId: 'c-1',
      authorUserId: OTHER,
      authorName: 'Omar Other',
      excerpt: 'Looks good @mia',
      whereLabel: 'Spring launch',
      link: { kind: 'comment', entityType: 'post', entityId: 'post-1', commentId: 'c-1' },
    });
  });

  it('a plan item comment quotes its plan and item', () => {
    expect(
      planCommentPrivateReplyDraft({
        commentId: 'pc-1',
        authorUserId: OTHER,
        authorName: 'Omar Other',
        excerpt: 'Swap the hero',
        whereLabel: 'Reel idea',
        planId: 'plan-1',
        itemId: 'item-1',
      }),
    ).toEqual({
      kind: 'plan_comment',
      sourceId: 'pc-1',
      authorUserId: OTHER,
      authorName: 'Omar Other',
      excerpt: 'Swap the hero',
      whereLabel: 'Reel idea',
      link: { kind: 'plan_comment', planId: 'plan-1', itemId: 'item-1', commentId: 'pc-1' },
    });
  });
});
