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
  buildBatchArgs,
  buildCreateInput,
  buildThreads,
  canModifyComment,
  commentActions,
  commentCopyText,
  commentDomId,
  parseBatchRows,
  renderCommentBody,
  replySeed,
  runCreateCommentBatch,
  runDeleteComment,
  runEditComment,
  toCommentAttachments,
  tombstoneText,
  writeClipboard,
} from '@/components/comments/Comments';
import type { Client } from '@srtdio/comments';
import { EX_MEMBER_LABEL, resolveName } from '@/components/comments/commentProfiles';
import type { CommentProfile } from '@/components/comments/commentProfiles';
import type { MentionCandidate } from '@/components/comments/useMentionCandidates';
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
    ledger_batch_id: null,
    ledger_seq: null,
    legacy_author_name: null,
    legacy_author_email: null,
    mentions: null,
    parent_comment_id: null,
    resolution_note: null,
    resolved_at: null,
    resolved_by: null,
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

  it('prefers the legacy author name over the resolved FK author', () => {
    const c = row({
      id: 'P',
      author_user_id: UUID_A,
      deleted_at: '2026-01-05T00:00:00.000Z',
      legacy_author_name: 'Bob (v1)',
    });
    expect(tombstoneText(c, (id) => (id === UUID_A ? 'Operator' : null))).toMatch(
      /^Deleted by Bob \(v1\) · /,
    );
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

  it('is false for a legacy (migrated) comment even when the current user is its FK author', () => {
    const legacy = row({ id: 'l', author_user_id: UUID_A, legacy_author_name: 'Bob (v1)' });
    expect(canModifyComment(legacy, UUID_A)).toBe(false);
  });
});

describe('legacy author display (migrated v1 comments)', () => {
  // The card computes the author name/avatar inline; mirror its exact expressions
  // over the same profiles map so a migrated comment is attributed to its frozen
  // v1 author, never the cutover operator whose FK it still carries.
  const profiles = new Map<string, CommentProfile>([
    [UUID_A, { displayName: 'Operator', avatarUrl: 'https://cdn/operator.png' }],
  ]);
  const nameOf = (id: string): string | null => resolveName(profiles, id);
  const avatarOf = (id: string): string | null => profiles.get(id)?.avatarUrl ?? null;

  it('renders the legacy name, not the resolved FK (operator) name', () => {
    const legacy = row({ id: 'l', author_user_id: UUID_A, legacy_author_name: 'Bob (v1)' });
    const authorName =
      legacy.legacy_author_name ?? nameOf(legacy.author_user_id) ?? EX_MEMBER_LABEL;
    expect(authorName).toBe('Bob (v1)');
    expect(authorName).not.toBe('Operator');
  });

  it('borrows no avatar for a legacy comment (initials only, no src)', () => {
    const legacy = row({ id: 'l', author_user_id: UUID_A, legacy_author_name: 'Bob (v1)' });
    const authorAvatarUrl =
      legacy.legacy_author_name !== null ? null : avatarOf(legacy.author_user_id);
    expect(authorAvatarUrl).toBeNull();
  });

  it('keeps the resolved name and avatar for a non-legacy comment', () => {
    const live = row({ id: 'c', author_user_id: UUID_A });
    const authorName = live.legacy_author_name ?? nameOf(live.author_user_id) ?? EX_MEMBER_LABEL;
    const authorAvatarUrl = live.legacy_author_name !== null ? null : avatarOf(live.author_user_id);
    expect(authorName).toBe('Operator');
    expect(authorAvatarUrl).toBe('https://cdn/operator.png');
  });
});

describe('replySeed (reply pre-tags the root author)', () => {
  // Mirror how the reply CommentComposer derives its initialBody: the author is
  // tagged only when they resolve to a mention candidate and are not the viewer.
  const candidates: MentionCandidate[] = [{ id: UUID_A, name: 'Ada', role: '', avatarUrl: null }];

  it('seeds @[author] when the root author resolves and differs from the current user', () => {
    const comment = row({ id: 'c', author_user_id: UUID_A });
    expect(replySeed(comment, UUID_B, candidates)).toBe(`@[${UUID_A}] `);
  });

  it('seeds nothing when the root author is the current user (never tag yourself)', () => {
    const comment = row({ id: 'c', author_user_id: UUID_A });
    expect(replySeed(comment, UUID_A, candidates)).toBe('');
  });

  it('seeds nothing for a legacy (ex-member) author', () => {
    const comment = row({ id: 'c', author_user_id: UUID_A, legacy_author_name: 'Bob (v1)' });
    expect(replySeed(comment, UUID_B, candidates)).toBe('');
  });

  it('seeds nothing when the author is not a mention candidate (cannot resolve)', () => {
    const comment = row({ id: 'c', author_user_id: UUID_B });
    expect(replySeed(comment, UUID_A, candidates)).toBe('');
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

  it('turns an http(s) URL into a safe new-tab anchor', () => {
    const tree = renderCommentBody('go https://srtd.io/abc now', () => null);
    const anchor = elements(tree).find((el) => el.type === 'a')!;
    expect(anchor).toBeDefined();
    const props = anchor.props as { href: string; target: string; rel: string };
    expect(props.href).toBe('https://srtd.io/abc');
    expect(props.target).toBe('_blank');
    expect(props.rel).toBe('noopener noreferrer');
    expect(text(tree)).toContain('https://srtd.io/abc');
  });

  it('trims trailing punctuation out of the anchor href but keeps it as text', () => {
    const tree = renderCommentBody('see https://srtd.io.', () => null);
    const anchor = elements(tree).find((el) => el.type === 'a')!;
    expect((anchor.props as { href: string }).href).toBe('https://srtd.io');
    expect(tree).toContain('.');
  });

  it('never links javascript: or scheme-less text', () => {
    const js = renderCommentBody('run javascript:alert(1) please', () => null);
    expect(elements(js).some((el) => el.type === 'a')).toBe(false);
    const bare = renderCommentBody('visit www.foo.com today', () => null);
    expect(elements(bare).some((el) => el.type === 'a')).toBe(false);
  });

  it('renders both a mention span and a URL anchor in one body', () => {
    const tree = renderCommentBody(`hi @[${UUID_A}] see https://srtd.io/x`, (id) =>
      id === UUID_A ? 'Ada' : null,
    );
    const span = elements(tree).find((el) => el.type === 'span')!;
    expect(text(span)).toContain('@Ada');
    const anchor = elements(tree).find((el) => el.type === 'a')!;
    expect((anchor.props as { href: string }).href).toBe('https://srtd.io/x');
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

describe('client checkpoint batch (comment_batch_create wiring)', () => {
  function clientWith(rpc: ReturnType<typeof vi.fn>): Client {
    return { rpc } as unknown as Client;
  }

  it('buildBatchArgs carries the points verbatim and the trace as p_trace_id', () => {
    const args = buildBatchArgs({
      workspaceId: 'ws',
      postId: 'post-1',
      points: [{ body: 'one' }, { body: 'two', attachment_version_ids: ['v1'] }],
      traceId: 'trace-b',
    });
    expect(args).toEqual({
      p_workspace_id: 'ws',
      p_post_id: 'post-1',
      p_points: [{ body: 'one' }, { body: 'two', attachment_version_ids: ['v1'] }],
      p_trace_id: 'trace-b',
    });
  });

  it('invokes the proc with the built args and returns the typed {id, seq} rows', async () => {
    const rpc = vi.fn(async () => ({
      data: [
        { id: 'c1', seq: 1 },
        { id: 'c2', seq: 2 },
      ],
      error: null,
    }));
    const result = await runCreateCommentBatch(clientWith(rpc), {
      workspaceId: 'ws',
      postId: 'post-1',
      points: [{ body: 'a' }, { body: 'b' }],
      traceId: 'trace-c',
    });
    expect(rpc).toHaveBeenCalledWith('comment_batch_create', {
      p_workspace_id: 'ws',
      p_post_id: 'post-1',
      p_points: [{ body: 'a' }, { body: 'b' }],
      p_trace_id: 'trace-c',
    });
    expect(result).toEqual({
      ok: true,
      data: [
        { id: 'c1', seq: 1 },
        { id: 'c2', seq: 2 },
      ],
    });
  });

  it('maps a raised domain code exactly as comment_create does', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: 'forbidden_role' } }));
    const result = await runCreateCommentBatch(clientWith(rpc), {
      workspaceId: 'ws',
      postId: 'post-1',
      points: [{ body: 'a' }],
      traceId: 't',
    });
    expect(result).toEqual({
      ok: false,
      error: { code: 'forbidden_role', message: 'forbidden_role' },
    });
  });

  it('maps an unexpected error to unknown, keeping the raw message', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: 'network down' } }));
    const result = await runCreateCommentBatch(clientWith(rpc), {
      workspaceId: 'ws',
      postId: 'post-1',
      points: [{ body: 'a' }],
      traceId: 't',
    });
    expect(result).toEqual({ ok: false, error: { code: 'unknown', message: 'network down' } });
  });

  it('parseBatchRows keeps only well-formed {id, seq} rows and never throws', () => {
    expect(
      parseBatchRows([
        { id: 'c1', seq: 1 },
        { id: 42, seq: 2 },
        { id: 'c3' },
        'garbage',
        null,
        ['c4', 4],
        { id: 'c5', seq: 5 },
      ]),
    ).toEqual([
      { id: 'c1', seq: 1 },
      { id: 'c5', seq: 5 },
    ]);
    expect(parseBatchRows(null)).toEqual([]);
    expect(parseBatchRows({ id: 'c1', seq: 1 })).toEqual([]);
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
