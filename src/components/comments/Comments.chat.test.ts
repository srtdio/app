import { describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import {
  COMMENT_PLACEHOLDER,
  commentLists,
  commentMenuOffer,
  commentMessage,
  latestRepliers,
  localCommentRow,
  pendingMessage,
  replyMentionSeed,
  threadUnread,
} from '@/components/comments/Comments';
import { commentFocusHref } from '@/lib/focus-target';
import { COMMENT_SELECT, threadReadAt, withTaskEmbeds, type CommentRow } from '@srtdio/comments';

const ME = '11111111-1111-4111-8111-111111111111';
const ANA = '22222222-2222-4222-8222-222222222222';

function row(over: Partial<CommentRow> & { id: string }): CommentRow {
  return {
    ...localCommentRow({
      id: over.id,
      workspaceId: 'w1',
      entityType: 'post',
      entityId: 'p1',
      authorUserId: ME,
      body: 'hi',
      attachmentVersionIds: [],
      parentCommentId: null,
      nowIso: '2026-11-11T10:00:00.000Z',
    }),
    ...over,
  };
}

describe('comment lists (chat order, replies never inline)', () => {
  it('roots oldest first; replies grouped under their root, oldest first; deleted replies dropped', () => {
    const rows = [
      row({ id: 'b', created_at: '2026-11-11T10:02:00Z' }),
      row({ id: 'a', created_at: '2026-11-11T10:01:00Z' }),
      row({ id: 'r2', parent_comment_id: 'a', created_at: '2026-11-11T10:05:00Z' }),
      row({ id: 'r1', parent_comment_id: 'a', created_at: '2026-11-11T10:04:00Z' }),
      row({
        id: 'rx',
        parent_comment_id: 'a',
        created_at: '2026-11-11T10:06:00Z',
        deleted_at: 'x',
      }),
    ];
    const lists = commentLists(rows);
    expect(lists.roots.map((r) => r.id)).toEqual(['a', 'b']);
    expect(lists.replies.get('a')?.map((r) => r.id)).toEqual(['r1', 'r2']);
  });

  it('a deleted root keeps its line only while it has a live reply', () => {
    const rows = [
      row({ id: 'gone', deleted_at: 'x' }),
      row({ id: 'kept', deleted_at: 'x' }),
      row({ id: 'r', parent_comment_id: 'kept' }),
    ];
    expect(commentLists(rows).roots.map((r) => r.id)).toEqual(['kept']);
  });

  it('a delete in its Undo window hides the row as if deleted', () => {
    const rows = [row({ id: 'a' }), row({ id: 'b' })];
    expect(commentLists(rows, new Set(['a'])).roots.map((r) => r.id)).toEqual(['b']);
  });

  it('old checkpoints and resolved comments render as ordinary messages', () => {
    const old = row({
      id: 'cp',
      ledger_seq: 3,
      resolved_at: 'x',
      accepted_at: 'y',
      body: 'Fix logo',
    });
    const m = commentMessage(old, ME, new Map());
    expect(m.body).toBe('Fix logo');
    expect(m.state).toBe('sent');
    expect(Object.keys(m)).not.toContain('ledger_seq');
  });
});

describe('unread (comment_thread_reads embedded in the one read)', () => {
  const replies = [
    { author_user_id: ANA, created_at: '2026-11-11T10:05:00Z' },
    { author_user_id: ME, created_at: '2026-11-11T10:06:00Z' },
  ];
  it('a reply by someone else newer than my read point is unread', () => {
    expect(threadUnread('2026-11-11T10:04:00Z', replies, ME)).toBe(true);
    expect(threadUnread('2026-11-11T10:05:00Z', replies, ME)).toBe(false);
  });
  it('no read row: unread only if someone else replied', () => {
    expect(threadUnread(null, replies, ME)).toBe(true);
    expect(threadUnread(null, [{ author_user_id: ME, created_at: 'x' }], ME)).toBe(false);
  });
  it('the select embeds the reads; the embed normalises to one timestamp or null', () => {
    expect(COMMENT_SELECT).toContain('comment_thread_reads(last_read_at)');
    expect(threadReadAt([{ last_read_at: '2026-11-11T10:00:00Z' }])).toBe('2026-11-11T10:00:00Z');
    expect(threadReadAt([])).toBeNull();
    const [r] = withTaskEmbeds([
      { ...row({ id: 'a' }), comment_thread_reads: [{ last_read_at: 't' }] },
    ]);
    expect(r?.thread_read_at).toBe('t');
  });
});

describe('replies row, menu, seeds, links', () => {
  it('up to 3 latest distinct repliers, newest first', () => {
    const ids = ['a', 'b', 'a', 'c', 'd'].map((author_user_id) => ({ author_user_id }));
    expect(latestRepliers(ids)).toEqual(['d', 'c', 'a']);
  });

  it('the menu hides what a person cannot do: Edit and Delete own only; To-do agency only, once', () => {
    const mine = row({ id: 'a' });
    const theirs = row({ id: 'b', author_user_id: ANA });
    expect(commentMenuOffer({ row: mine, me: ME, viewerIsAgency: false })).toEqual({
      react: true,
      todo: false,
      edit: true,
      copy: true,
      copyLink: true,
      delete: true,
    });
    const other = commentMenuOffer({ row: theirs, me: ME, viewerIsAgency: true });
    expect(other.edit).toBe(false);
    expect(other.delete).toBe(false);
    expect(other.todo).toBe(true);
    expect(
      commentMenuOffer({ row: { ...theirs, task_state: 'assigned' }, me: ME, viewerIsAgency: true })
        .todo,
    ).toBe(false);
    expect(
      commentMenuOffer({
        row: { ...mine, legacy_author_name: 'Old' },
        me: ME,
        viewerIsAgency: true,
      }).edit,
    ).toBe(false);
  });

  it('a reply to a reply starts with @Name (never mine, never a legacy author)', () => {
    expect(replyMentionSeed({ author_user_id: ANA, legacy_author_name: null }, ME)).toBe(
      `@[${ANA}] `,
    );
    expect(replyMentionSeed({ author_user_id: ME, legacy_author_name: null }, ME)).toBe('');
    expect(replyMentionSeed({ author_user_id: ANA, legacy_author_name: 'X' }, ME)).toBe('');
  });

  it('a pending send is chat clock, a failed one Not sent (with its refusal)', () => {
    const base = {
      localId: 'pending:1',
      parentId: null,
      body: 'x',
      attachments: [],
      createdAt: '2026-11-11T10:00:00Z',
      quote: null,
    };
    expect(pendingMessage({ ...base, failed: false }, ME).state).toBe('sending');
    const failed = pendingMessage({ ...base, failed: true, refusal: 'No' }, ME);
    expect(failed.state).toBe('failed');
    expect(failed.refusal).toBe('No');
  });

  it('Copy link points at the post or brief with ?comment=', () => {
    expect(commentFocusHref('post', 'p1', 'c1')).toBe('/posts/p1?comment=c1');
    expect(commentFocusHref('brief', 'b1', 'c1')).toBe('/briefs/b1?comment=c1');
  });

  it('the comment box hint stays as today', () => {
    expect(COMMENT_PLACEHOLDER).toBe('Write a comment');
  });
});
