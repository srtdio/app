import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';

// editComment / deleteComment are spied so we can assert the wrapper asymmetry
// (traceId is POSITIONAL on these two, but rides INSIDE the createComment input).
// Every other export is the real module so importing Comments stays intact.
vi.mock('@srtdio/comments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@srtdio/comments')>();
  return {
    ...actual,
    editComment: vi.fn(async () => ({ ok: true, data: 'edited' })),
    deleteComment: vi.fn(async () => ({ ok: true, data: 'deleted' })),
  };
});

import { editComment, deleteComment } from '@srtdio/comments';
import type { CommentRow } from '@srtdio/comments';
import {
  annotationChip,
  buildCreateInput,
  buildThreads,
  canModifyComment,
  commentActions,
  commentCopyText,
  commentDomId,
  renderCommentBody,
  runDeleteComment,
  runEditComment,
  toCommentAttachments,
  tombstoneText,
  writeClipboard,
} from '@/components/comments/Comments';
import { resolveName } from '@/components/comments/commentProfiles';
import { attachmentView } from '@/components/chat/MessageAttachments';

// Node unit environment: walk the JSX returned by the hookless helpers and
// assert structure / text, rather than mounting the stateful Comments list.

function flatten(node: ReactNode, out: ReactElement[]): void {
  if (Array.isArray(node)) {
    node.forEach((child) => flatten(child, out));
    return;
  }
  if (node === null || typeof node !== 'object' || !('props' in node)) return;
  const el = node as ReactElement;
  out.push(el);
  flatten((el.props as { children?: ReactNode }).children, out);
}

function elements(tree: ReactNode): ReactElement[] {
  const out: ReactElement[] = [];
  flatten(tree, out);
  return out;
}

function text(tree: ReactNode): string {
  const parts: string[] = [];
  for (const el of elements(tree)) {
    const children = (el.props as { children?: ReactNode }).children;
    const kids = Array.isArray(children) ? children : [children];
    for (const child of kids) {
      if (typeof child === 'string' || typeof child === 'number') parts.push(String(child));
    }
  }
  return parts.join('');
}

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

function row(partial: Partial<CommentRow> & { id: string }): CommentRow {
  return {
    attachment_asset_ids: null,
    author_user_id: UUID_A,
    body: '',
    created_at: '2026-01-01T00:00:00.000Z',
    deleted_at: null,
    edited_at: null,
    entity_id: 'entity',
    entity_type: 'post',
    is_decision: false,
    mentions: null,
    parent_comment_id: null,
    workspace_id: 'ws',
    ...partial,
  };
}

describe('commentDomId', () => {
  it('builds a stable per-comment row id', () => {
    expect(commentDomId('abc')).toBe('comment-abc');
  });
});

describe('annotationChip (F4/F5 seam)', () => {
  it('renders a clickable live chip that calls onAnnotationChipClick', () => {
    const onClick = vi.fn();
    const tree = annotationChip(
      'c1',
      { n: 2, quote: 'great hook', stale: false, versionNumber: 3 },
      onClick,
    );
    const button = elements(tree).find((el) => el.type === 'button')!;
    expect(button).toBeDefined();
    expect(text(tree)).toContain('great hook');
    (button.props as { onClick: () => void }).onClick();
    expect(onClick).toHaveBeenCalledWith('c1');
  });

  it('renders a greyed, non-interactive stale chip', () => {
    const tree = annotationChip(
      'c2',
      { n: 0, quote: 'old copy', stale: true, versionNumber: 1 },
      vi.fn(),
    );
    expect(elements(tree).some((el) => el.type === 'button')).toBe(false);
    expect(text(tree)).toContain('copy changed · v1');
    expect(text(tree)).toContain('old copy');
  });

  it('renders nothing when there is no annotation (brief parity)', () => {
    expect(annotationChip('c3', undefined)).toBeNull();
  });
});

describe('buildThreads', () => {
  it('splits roots from replies and keeps replies oldest-first under their root', () => {
    const rows = [
      row({ id: 'A', created_at: '2026-01-03T00:00:00.000Z' }),
      row({ id: 'A2', parent_comment_id: 'A', created_at: '2026-01-04T00:00:00.000Z' }),
      row({ id: 'A1', parent_comment_id: 'A', created_at: '2026-01-02T00:00:00.000Z' }),
      row({ id: 'B', created_at: '2026-01-01T00:00:00.000Z' }),
    ];
    const threads = buildThreads(rows);
    expect(threads.map((t) => t.comment.id)).toEqual(['A', 'B']);
    expect(threads[0]!.replies.map((r) => r.id)).toEqual(['A1', 'A2']);
    expect(threads[1]!.replies).toHaveLength(0);
  });

  it('never surfaces a reply-to-reply (one level only)', () => {
    const rows = [
      row({ id: 'A' }),
      row({ id: 'A1', parent_comment_id: 'A' }),
      row({ id: 'A1a', parent_comment_id: 'A1' }),
    ];
    const threads = buildThreads(rows);
    const ids = threads.flatMap((t) => [t.comment.id, ...t.replies.map((r) => r.id)]);
    expect(ids).toEqual(['A', 'A1']);
    expect(ids).not.toContain('A1a');
  });

  it('tombstones a deleted parent that still has a live reply', () => {
    const rows = [
      row({ id: 'P', deleted_at: '2026-01-05T00:00:00.000Z' }),
      row({ id: 'R', parent_comment_id: 'P' }),
    ];
    const threads = buildThreads(rows);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.comment.id).toBe('P');
    expect(threads[0]!.tombstone).toBe(true);
    expect(threads[0]!.replies.map((r) => r.id)).toEqual(['R']);
  });

  it('omits a deleted comment with no live reply', () => {
    const rows = [
      row({ id: 'D', deleted_at: '2026-01-05T00:00:00.000Z' }),
      row({ id: 'D2', deleted_at: '2026-01-06T00:00:00.000Z' }),
      row({ id: 'D2r', parent_comment_id: 'D2', deleted_at: '2026-01-07T00:00:00.000Z' }),
    ];
    expect(buildThreads(rows)).toHaveLength(0);
  });

  it('returns a flat list of roots for the brief mount (no parents)', () => {
    const rows = [row({ id: 'x' }), row({ id: 'y' })];
    const threads = buildThreads(rows);
    expect(threads.map((t) => t.comment.id)).toEqual(['x', 'y']);
    expect(threads.every((t) => t.replies.length === 0 && !t.tombstone)).toBe(true);
  });
});

describe('tombstoneText', () => {
  it('names the deleter when the author resolves', () => {
    const c = row({ id: 'P', author_user_id: UUID_A, deleted_at: '2026-01-05T00:00:00.000Z' });
    expect(tombstoneText(c, (id) => (id === UUID_A ? 'Ada' : null))).toMatch(/^Deleted by Ada · /);
  });

  it('stays anonymous when the author no longer resolves', () => {
    const c = row({ id: 'P', deleted_at: '2026-01-05T00:00:00.000Z' });
    expect(tombstoneText(c, () => null)).toMatch(/^Comment deleted · /);
  });
});

describe('canModifyComment', () => {
  it('is true only for the current user own, live comment', () => {
    const mine = row({ id: 'm', author_user_id: UUID_A });
    expect(canModifyComment(mine, UUID_A)).toBe(true);
    expect(canModifyComment(row({ id: 'o', author_user_id: UUID_B }), UUID_A)).toBe(false);
    expect(canModifyComment(mine, null)).toBe(false);
    const deleted = row({
      id: 'd',
      author_user_id: UUID_A,
      deleted_at: '2026-01-05T00:00:00.000Z',
    });
    expect(canModifyComment(deleted, UUID_A)).toBe(false);
  });
});

describe('renderCommentBody (author + mention resolution)', () => {
  it('renders a resolved mention as @Name in accent', () => {
    const tree = renderCommentBody(`hi @[${UUID_A}] there`, (id) => (id === UUID_A ? 'Ada' : null));
    expect(text(tree)).toContain('@Ada');
    const span = elements(tree).find((el) => el.type === 'span')!;
    expect((span.props as { className: string }).className).toContain('text-accent');
  });

  it('renders an unresolved mention as @(ex-member)', () => {
    const tree = renderCommentBody(`ping @[${UUID_B}]`, () => null);
    expect(text(tree)).toContain('@(ex-member)');
  });

  it('resolves an author id to a display name (not the raw uuid)', () => {
    const profiles = new Map([[UUID_A, { displayName: 'Ada', avatarUrl: null }]]);
    expect(resolveName(profiles, UUID_A)).toBe('Ada');
    expect(resolveName(profiles, UUID_B)).toBeNull();
  });
});

describe('write-action wiring', () => {
  it('buildCreateInput carries parent_comment_id, version ids, and an IN-input trace', () => {
    const input = buildCreateInput({
      workspaceId: 'ws',
      entityType: 'post',
      entityId: 'e',
      body: 'reply body',
      attachmentVersionIds: ['v1', 'v2'],
      isDecision: false,
      parentCommentId: 'parent-1',
      traceId: 'trace-xyz',
    });
    expect(input.parent_comment_id).toBe('parent-1');
    expect(input.attachment_asset_ids).toEqual(['v1', 'v2']);
    expect(input.trace_id).toBe('trace-xyz');
  });

  it('a root comment has a null parent_comment_id', () => {
    const input = buildCreateInput({
      workspaceId: 'ws',
      entityType: 'brief',
      entityId: 'e',
      body: 'top',
      attachmentVersionIds: [],
      isDecision: false,
      parentCommentId: null,
      traceId: 't',
    });
    expect(input.parent_comment_id).toBeNull();
  });

  it('runEditComment passes traceId POSITIONALLY', async () => {
    const client = {} as never;
    await runEditComment(client, 'cid', 'new body', 'trace-1');
    expect(editComment).toHaveBeenCalledWith(
      client,
      { commentId: 'cid', body: 'new body' },
      'trace-1',
    );
  });

  it('runDeleteComment passes traceId POSITIONALLY', async () => {
    const client = {} as never;
    await runDeleteComment(client, 'cid', 'trace-2');
    expect(deleteComment).toHaveBeenCalledWith(client, { commentId: 'cid' }, 'trace-2');
  });
});

describe('copy comment text', () => {
  it('offers Copy on any comment (author-independent), edit/delete author-only', () => {
    const others = row({ id: 'o', author_user_id: UUID_B });
    expect(commentActions(others, UUID_A, false)).toEqual({
      canCopy: true,
      canEdit: false,
      canDelete: false,
    });
    const mine = row({ id: 'm', author_user_id: UUID_A });
    expect(commentActions(mine, UUID_A, false)).toEqual({
      canCopy: true,
      canEdit: true,
      canDelete: true,
    });
  });

  it('offers no actions on a tombstone', () => {
    const deleted = row({ id: 'd', deleted_at: '2026-01-05T00:00:00.000Z' });
    expect(commentActions(deleted, UUID_A, true)).toEqual({
      canCopy: false,
      canEdit: false,
      canDelete: false,
    });
  });

  it('copies the body with mentions resolved to @Name', () => {
    expect(commentCopyText(`see @[${UUID_A}] now`, (id) => (id === UUID_A ? 'Ada' : null))).toBe(
      'see @Ada now',
    );
    expect(commentCopyText(`plain text`, () => null)).toBe('plain text');
  });

  it('writes the comment body to the clipboard and never throws', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await expect(writeClipboard('hello body')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello body');

    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: async () => {
          throw new Error('denied');
        },
      },
    });
    await expect(writeClipboard('x')).resolves.toBe(false);
    vi.unstubAllGlobals();
  });
});

describe('comment attachments', () => {
  it('maps stored version ids to renderable attachments with resolved mime', () => {
    const out = toCommentAttachments(['v1', 'v2'], new Map([['v1', 'image/png']]));
    expect(out).toEqual([
      { assetId: 'v1', name: '', mime: 'image/png' },
      { assetId: 'v2', name: '', mime: '' },
    ]);
  });

  it('an image attachment renders via the presign path (reused attachmentView)', () => {
    const [image] = toCommentAttachments(['v1'], new Map([['v1', 'image/png']]));
    const view = attachmentView({
      attachment: image!,
      presignEnabled: true,
      url: 'https://signed/thumb.png',
      failed: false,
    });
    expect(view).toEqual({ kind: 'image', src: 'https://signed/thumb.png', alt: '' });
  });

  it('a non-image attachment renders as a file chip', () => {
    const [file] = toCommentAttachments(['v9'], new Map());
    const view = attachmentView({
      attachment: file!,
      presignEnabled: true,
      url: null,
      failed: false,
    });
    expect(view.kind).toBe('file');
  });
});
