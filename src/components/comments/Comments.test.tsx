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
  checkpointReplySeed,
  checkpointState,
  checkpointStateLabel,
  checkpointWithdrawalText,
  groupThreads,
  canModifyComment,
  commentActions,
  commentCopyText,
  commentDomId,
  isPointFrozen,
  mergeCheckpoints,
  parseBatchRows,
  pointActions,
  pointMenuMode,
  pointEditedMarker,
  pointWordCount,
  POINT_WORD_CAP,
  PUSHBACK_SEED,
  renderCommentBody,
  renderReplyList,
  replySeed,
  runCreateCommentBatch,
  runDeleteComment,
  runEditComment,
  showCheckpointNotDone,
  showCheckpointUndo,
  showCheckpointWithdrawal,
  tickFilled,
  tickInteractive,
  toCommentAttachments,
  tombstoneText,
  writeClipboard,
} from '@/components/comments/Comments';
import type { PointMenuMode } from '@/components/comments/Comments';
import { PAGE_SIZE } from '@srtdio/comments';
import type { Client } from '@srtdio/comments';
import { friendlyPointFreezeError, tickCircle } from '@/components/pages/pcs/checkpoint-controls';
import type { DomainError } from '@srtdio/rpc';
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
    accepted_at: null,
    accepted_by: null,
    asked_at: null,
    asked_by: null,
    attachment_asset_ids: null,
    author_user_id: UUID_A,
    body: '',
    closed_at: null,
    closed_by: null,
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
    resolved_version_id: null,
    sent_back_at: null,
    sent_back_by: null,
    unaccepted_at: null,
    unaccepted_by: null,
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

describe('groupThreads (feedback ledger: consecutive same-author checkpoints collapse)', () => {
  const BATCH_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  function checkpoint(id: string, seq: number, author: string, created: string) {
    return row({
      id,
      ledger_seq: seq,
      ledger_batch_id: BATCH_A,
      author_user_id: author,
      created_at: created,
    });
  }

  it('collapses consecutive same-author checkpoints, newest send on top, seq ascending inside a send', () => {
    const threads = buildThreads([
      // Newest-first list order; two sends (t2 newer than t1), each with two points.
      checkpoint('c4', 4, UUID_A, '2026-01-02T00:00:02.000Z'),
      checkpoint('c3', 3, UUID_A, '2026-01-02T00:00:02.000Z'),
      checkpoint('c2', 2, UUID_A, '2026-01-01T00:00:01.000Z'),
      checkpoint('c1', 1, UUID_A, '2026-01-01T00:00:01.000Z'),
      row({ id: 'plain', created_at: '2025-12-31T00:00:00.000Z' }),
    ]);
    const groups = groupThreads(threads);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ kind: 'batch', authorId: UUID_A });
    if (groups[0]!.kind !== 'batch') throw new Error('expected a batch');
    // created_at DESC across sends, ledger_seq ASC within a send (tie-break).
    expect(groups[0]!.threads.map((t) => t.comment.ledger_seq)).toEqual([3, 4, 1, 2]);
    expect(groups[1]).toMatchObject({ kind: 'single' });
  });

  it('splits distinct authors into distinct cards', () => {
    const threads = buildThreads([
      checkpoint('b1', 4, UUID_B, '2026-01-03T00:00:00.000Z'),
      checkpoint('a2', 2, UUID_A, '2026-01-02T00:00:02.000Z'),
      checkpoint('a1', 1, UUID_A, '2026-01-02T00:00:01.000Z'),
    ]);
    const groups = groupThreads(threads);
    expect(groups.map((g) => g.kind)).toEqual(['batch', 'batch']);
    if (groups[0]!.kind !== 'batch' || groups[1]!.kind !== 'batch') throw new Error('batches');
    expect(groups[0]!.authorId).toBe(UUID_B);
    expect(groups[1]!.authorId).toBe(UUID_A);
  });

  it('only adjacency groups: an ordinary comment between runs keeps them apart', () => {
    const threads = buildThreads([
      checkpoint('a2', 2, UUID_A, '2026-01-04T00:00:00.000Z'),
      row({ id: 'between', created_at: '2026-01-03T00:00:00.000Z' }),
      checkpoint('a1', 1, UUID_A, '2026-01-02T00:00:00.000Z'),
    ]);
    const groups = groupThreads(threads);
    expect(groups.map((g) => g.kind)).toEqual(['batch', 'single', 'batch']);
  });

  it('a non-checkpoint comment stays single even if a batch id somehow rides along', () => {
    const threads = buildThreads([row({ id: 'odd', ledger_seq: null, ledger_batch_id: BATCH_A })]);
    expect(groupThreads(threads).map((g) => g.kind)).toEqual(['single']);
  });

  it('carries each checkpoint thread whole, replies included (replies stay children)', () => {
    const threads = buildThreads([
      checkpoint('cp', 1, UUID_A, '2026-01-02T00:00:00.000Z'),
      row({ id: 'r1', parent_comment_id: 'cp', created_at: '2026-01-02T01:00:00.000Z' }),
    ]);
    const groups = groupThreads(threads);
    if (groups[0]!.kind !== 'batch') throw new Error('expected a batch');
    expect(groups[0]!.threads[0]!.replies.map((r) => r.id)).toEqual(['r1']);
  });
});

describe('checkpoint state + feed controls', () => {
  const RESOLVED = '2026-02-01T00:00:00.000Z';
  const ACCEPTED = '2026-02-02T00:00:00.000Z';
  const WITHDRAWN = '2026-02-03T00:00:00.000Z';

  const open = row({ id: 'open', ledger_seq: 1, resolved_at: null, accepted_at: null });
  const clientTurn = row({ id: 'ct', ledger_seq: 2, resolved_at: RESOLVED, accepted_at: null });
  const confirmed = row({
    id: 'cf',
    ledger_seq: 3,
    resolved_at: RESOLVED,
    accepted_at: ACCEPTED,
  });

  it('derives state from the resolved / accepted columns only', () => {
    expect(checkpointState(open)).toBe('open');
    expect(checkpointState(clientTurn)).toBe('client_turn');
    expect(checkpointState(confirmed)).toBe('confirmed');
    // Confirmed requires resolved: an agency reopen (resolved_at null) is 'open'
    // regardless of a lingering accepted stamp.
    expect(checkpointState(row({ id: 'x', resolved_at: null, accepted_at: ACCEPTED }))).toBe(
      'open',
    );
  });

  it('labels each state with the right wording per side and a chip token pair', () => {
    expect(checkpointStateLabel('open', true)).toEqual({
      text: 'With agency',
      className: 'bg-panel-3 text-fg-3',
    });
    expect(checkpointStateLabel('open', false)).toEqual({
      text: 'Open',
      className: 'bg-panel-3 text-fg-3',
    });
    expect(checkpointStateLabel('client_turn', true)).toEqual({
      text: 'Your turn',
      className: 'bg-accent-soft text-accent',
    });
    expect(checkpointStateLabel('client_turn', false)).toEqual({
      text: 'With client',
      className: 'bg-accent-soft text-accent',
    });
    expect(checkpointStateLabel('confirmed', true)).toEqual({
      text: 'Confirmed',
      className: 'bg-good-soft text-good',
    });
    expect(checkpointStateLabel('confirmed', false).text).toBe('Confirmed');
  });

  // Every className across the tickCircle subtree, joined, so a substring match
  // can assert the colour treatment regardless of which span carries it.
  const tickClasses = (done: boolean, live = false): string =>
    elements(tickCircle(done, live))
      .map((el) => (el.props as { className?: string }).className ?? '')
      .join(' ');

  it('renders an unconfirmed tick with a visible ghost glyph and good-family outline', () => {
    const cls = tickClasses(false, false);
    expect(cls).toContain('border-good'); // good-family outline
    expect(cls).toContain('bg-good-soft'); // soft green fill
    expect(cls).toContain('text-good'); // ghost glyph colour
    expect(cls).not.toContain('text-transparent'); // glyph stays visible
    expect(cls).not.toContain('opacity-0'); // glyph not faded out
  });

  it('adds the good-family halo only on a live, unconfirmed tick', () => {
    expect(tickClasses(false, true)).toContain('ring-good-soft'); // live: halo
    expect(tickClasses(false, false)).not.toContain('ring-good-soft'); // passive: none
  });

  it('renders a confirmed tick with the filled treatment', () => {
    const cls = tickClasses(true);
    expect(cls).toContain('bg-good');
    expect(cls).toContain('text-white');
    expect(cls).toContain('opacity-100');
    expect(cls).not.toContain('ring-good-soft');
  });

  it('makes the tick live for an agency member only when the checkpoint is open', () => {
    expect(tickInteractive('open', false)).toBe(true);
    expect(tickInteractive('client_turn', false)).toBe(false);
    expect(tickInteractive('confirmed', false)).toBe(false);
  });

  it('makes the tick live for a client only when resolved and unconfirmed', () => {
    expect(tickInteractive('client_turn', true)).toBe(true);
    expect(tickInteractive('open', true)).toBe(false);
    expect(tickInteractive('confirmed', true)).toBe(false);
  });

  it('fills the agency tick once resolved, the client tick once confirmed', () => {
    expect(tickFilled('open', false)).toBe(false);
    expect(tickFilled('client_turn', false)).toBe(true);
    expect(tickFilled('confirmed', false)).toBe(true);
    expect(tickFilled('open', true)).toBe(false);
    expect(tickFilled('client_turn', true)).toBe(false);
    expect(tickFilled('confirmed', true)).toBe(true);
  });

  it('shows the client "Not done" only when resolved and "Undo" only when confirmed', () => {
    expect(showCheckpointNotDone('client_turn', true)).toBe(true);
    expect(showCheckpointNotDone('open', true)).toBe(false);
    expect(showCheckpointNotDone('confirmed', true)).toBe(false);
    expect(showCheckpointUndo('confirmed', true)).toBe(true);
    expect(showCheckpointUndo('client_turn', true)).toBe(false);
  });

  it('shows an agency member neither "Not done" nor "Undo" in any state', () => {
    for (const state of ['open', 'client_turn', 'confirmed'] as const) {
      expect(showCheckpointNotDone(state, false)).toBe(false);
      expect(showCheckpointUndo(state, false)).toBe(false);
    }
  });

  it('surfaces the withdrawal line after a client undo, not after an agency un-tick', () => {
    // Client withdrew: still resolved, unconfirmed, with an unaccepted stamp.
    const clientUndo = row({
      id: 'u',
      resolved_at: RESOLVED,
      accepted_at: null,
      unaccepted_at: WITHDRAWN,
      unaccepted_by: UUID_B,
    });
    expect(showCheckpointWithdrawal(clientUndo)).toBe(true);
    // Agency un-tick: back to open (resolved_at null), even with a stale stamp.
    const agencyUntick = row({
      id: 'a',
      resolved_at: null,
      accepted_at: null,
      unaccepted_at: WITHDRAWN,
      unaccepted_by: UUID_B,
    });
    expect(showCheckpointWithdrawal(agencyUntick)).toBe(false);
    // Never confirmed, no stamp: nothing to show.
    expect(showCheckpointWithdrawal(clientTurn)).toBe(false);
  });

  it('names the withdrawing member, falling back to the ex-member label', () => {
    expect(checkpointWithdrawalText(WITHDRAWN, 'Ada')).toMatch(/^Confirmation withdrawn by Ada · /);
    expect(checkpointWithdrawalText(WITHDRAWN, null)).toMatch(
      /^Confirmation withdrawn by \(ex-member\) · /,
    );
  });

  it('seeds the reply composer with the pushback prompt only on a "Not done"', () => {
    const candidates: MentionCandidate[] = [{ id: UUID_A, name: 'Ada', role: '', avatarUrl: null }];
    const checkpoint = row({ id: 'c', author_user_id: UUID_A, ledger_seq: 1 });
    // Pushing back opens the composer pre-filled so the client must say why.
    expect(checkpointReplySeed(true, checkpoint, UUID_B, candidates)).toBe(PUSHBACK_SEED);
    expect(PUSHBACK_SEED.length).toBeGreaterThan(0);
    expect(PUSHBACK_SEED).not.toContain('—');
    // Otherwise it is the ordinary author pre-tag.
    expect(checkpointReplySeed(false, checkpoint, UUID_B, candidates)).toBe(`@[${UUID_A}] `);
  });
});

describe('mergeCheckpoints (checkpoints never paginate away)', () => {
  it('de-dupes a checkpoint that is in both lists and keeps newest-first order', () => {
    const shared = row({ id: 'cp1', ledger_seq: 1, created_at: '2026-01-05T00:00:00.000Z' });
    const plain = row({ id: 'p', created_at: '2026-01-06T00:00:00.000Z' });
    const merged = mergeCheckpoints([plain, shared], [shared]);
    expect(merged.map((r) => r.id)).toEqual(['p', 'cp1']);
  });

  it('surfaces every checkpoint on a post with more than PAGE_SIZE comments', () => {
    // A full page-zero of ordinary, newer comments; the checkpoint is older, so it
    // would fall beyond page zero, yet the whole-checkpoint read still carries it.
    const paged = Array.from({ length: PAGE_SIZE }, (_unused, i) =>
      row({
        id: `plain-${i}`,
        created_at: `2026-03-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
      }),
    );
    const buried = row({
      id: 'buried-cp',
      ledger_seq: 1,
      author_user_id: UUID_A,
      created_at: '2026-01-01T00:00:00.000Z',
    });
    const merged = mergeCheckpoints(paged, [buried]);
    expect(merged.some((r) => r.id === 'buried-cp')).toBe(true);
    // And it still renders: it groups into a checkpoint batch card.
    const groups = groupThreads(buildThreads(merged));
    const batch = groups.find((g) => g.kind === 'batch');
    expect(batch).toBeDefined();
    if (batch!.kind !== 'batch') throw new Error('expected a batch');
    expect(batch!.threads.some((t) => t.comment.id === 'buried-cp')).toBe(true);
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

describe('ledger point edit/delete affordance (author-only, frozen at confirmed/locked)', () => {
  const ACCEPTED = '2026-02-02T00:00:00.000Z';
  const CLOSED = '2026-02-05T00:00:00.000Z';

  function point(partial: Partial<CommentRow>): CommentRow {
    return row({ id: 'p', ledger_seq: 1, author_user_id: UUID_A, ...partial });
  }

  it('shows Edit and Delete on an own point in working state (open, unconfirmed)', () => {
    const working = point({ resolved_at: null, accepted_at: null, closed_at: null });
    expect(pointActions(working, UUID_A, false)).toEqual({
      canCopy: true,
      canEdit: true,
      canDelete: true,
    });
  });

  it('shows Edit and Delete on an own point in ready state (resolved, unconfirmed)', () => {
    const ready = point({
      resolved_at: '2026-02-01T00:00:00.000Z',
      accepted_at: null,
      closed_at: null,
    });
    expect(pointActions(ready, UUID_A, false)).toEqual({
      canCopy: true,
      canEdit: true,
      canDelete: true,
    });
  });

  it('hides Edit and Delete on a confirmed point (accepted_at), keeping Copy', () => {
    const confirmed = point({ accepted_at: ACCEPTED, closed_at: null });
    expect(isPointFrozen(confirmed)).toBe(true);
    expect(pointActions(confirmed, UUID_A, false)).toEqual({
      canCopy: true,
      canEdit: false,
      canDelete: false,
    });
  });

  it('hides Edit and Delete on a locked point (closed_at), keeping Copy', () => {
    const locked = point({ accepted_at: null, closed_at: CLOSED });
    expect(isPointFrozen(locked)).toBe(true);
    expect(pointActions(locked, UUID_A, false)).toEqual({
      canCopy: true,
      canEdit: false,
      canDelete: false,
    });
  });

  it("hides Edit and Delete on another member's point, keeping Copy", () => {
    const theirs = point({ author_user_id: UUID_B, accepted_at: null, closed_at: null });
    expect(pointActions(theirs, UUID_A, false)).toEqual({
      canCopy: true,
      canEdit: false,
      canDelete: false,
    });
  });

  it('offers no actions on a tombstoned point', () => {
    const dead = point({ deleted_at: '2026-01-05T00:00:00.000Z' });
    expect(pointActions(dead, UUID_A, true)).toEqual({
      canCopy: false,
      canEdit: false,
      canDelete: false,
    });
  });

  it('enforces the 50-word point cap the way the proc counts words', () => {
    expect(POINT_WORD_CAP).toBe(50);
    const fifty = Array.from({ length: 50 }, (_u, i) => `w${i}`).join(' ');
    const fiftyOne = `${fifty} over`;
    expect(pointWordCount('   ')).toBe(0);
    expect(pointWordCount('  one  two   three ')).toBe(3);
    expect(pointWordCount(fifty)).toBe(POINT_WORD_CAP);
    expect(pointWordCount(fiftyOne)).toBeGreaterThan(POINT_WORD_CAP);
  });

  it('renders the edited marker with a timestamp only once a point is edited', () => {
    const now = new Date('2026-03-01T00:00:00.000Z');
    expect(pointEditedMarker(null, now)).toBeNull();
    const marker = pointEditedMarker('2026-02-28T00:00:00.000Z', now);
    expect(marker).not.toBeNull();
    expect(marker!.startsWith('edited · ')).toBe(true);
    expect(marker).not.toContain('—');
  });

  it('maps checkpoint_frozen to confirmed / locked copy and keeps every string em-dash free', () => {
    const frozen: DomainError = { code: 'unknown', message: 'checkpoint_frozen' };
    // Confirmed point (accepted_at set, not locked): edit vs delete wording.
    expect(
      friendlyPointFreezeError(frozen, { accepted_at: ACCEPTED, closed_at: null }, 'edit'),
    ).toBe('This point is confirmed. It can no longer be edited.');
    expect(
      friendlyPointFreezeError(frozen, { accepted_at: ACCEPTED, closed_at: null }, 'delete'),
    ).toBe('This point is confirmed. It can no longer be deleted.');
    // Locked post wins even when the point is also confirmed.
    expect(
      friendlyPointFreezeError(frozen, { accepted_at: ACCEPTED, closed_at: CLOSED }, 'edit'),
    ).toBe('This post is approved. Points are locked.');
    for (const action of ['edit', 'delete'] as const) {
      const msg = friendlyPointFreezeError(
        frozen,
        { accepted_at: null, closed_at: CLOSED },
        action,
      );
      expect(msg).toBe('This post is approved. Points are locked.');
      expect(msg).not.toContain('—');
    }
  });
});

describe('pointMenuMode (kebab menu vs direct copy button vs nothing)', () => {
  const FROZEN = '2026-02-02T00:00:00.000Z';

  function point(partial: Partial<CommentRow>): CommentRow {
    return row({ id: 'p', ledger_seq: 1, author_user_id: UUID_A, ...partial });
  }

  it('returns the full menu when the viewer can edit or delete (author, live point)', () => {
    const live = point({ accepted_at: null, closed_at: null });
    expect(pointMenuMode(pointActions(live, UUID_A, false))).toBe('menu');
  });

  it('returns a direct copy for a non-author on a live point (copy only, no menu)', () => {
    const theirs = point({ author_user_id: UUID_B, accepted_at: null, closed_at: null });
    expect(pointMenuMode(pointActions(theirs, UUID_A, false))).toBe('copy');
  });

  it('returns a direct copy for the author of a frozen point (not an author check)', () => {
    const frozen = point({ accepted_at: FROZEN, closed_at: null });
    // Confirmed against its own author: copy stays, edit/delete gone.
    expect(pointMenuMode(pointActions(frozen, UUID_A, false))).toBe('copy');
  });

  it('returns nothing on a tombstone', () => {
    const dead = point({ deleted_at: '2026-01-05T00:00:00.000Z' });
    expect(pointMenuMode(pointActions(dead, UUID_A, true))).toBe('none');
  });

  it('a copy-only viewer gets the "Copy text" button and no "Point actions" trigger; an author gets "Point actions"', () => {
    // The card renders one control per mode: 'menu' -> the "Point actions" kebab,
    // 'copy' -> a direct "Copy text" button, 'none' -> nothing. Assert the label
    // the render branch selects for each viewer.
    const CONTROL_LABEL: Record<PointMenuMode, string | null> = {
      none: null,
      copy: 'Copy text',
      menu: 'Point actions',
    };
    const frozenOwn = point({ accepted_at: FROZEN, closed_at: null });
    const copyMode = pointMenuMode(pointActions(frozenOwn, UUID_A, false));
    expect(copyMode).toBe('copy');
    expect(CONTROL_LABEL[copyMode]).toBe('Copy text');
    expect(CONTROL_LABEL[copyMode]).not.toBe('Point actions');

    const liveOwn = point({ accepted_at: null, closed_at: null });
    const menuMode = pointMenuMode(pointActions(liveOwn, UUID_A, false));
    expect(menuMode).toBe('menu');
    expect(CONTROL_LABEL[menuMode]).toBe('Point actions');
  });
});

describe('deleted point renders a tombstone with its replies still present', () => {
  const BATCH = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  it('keeps a soft-deleted point as a tombstone batch while a live reply remains', () => {
    const rows = [
      row({
        id: 'cp',
        ledger_seq: 1,
        ledger_batch_id: BATCH,
        author_user_id: UUID_A,
        deleted_at: '2026-02-10T00:00:00.000Z',
        created_at: '2026-02-01T00:00:00.000Z',
      }),
      row({
        id: 'r1',
        parent_comment_id: 'cp',
        body: 'still here',
        created_at: '2026-02-02T00:00:00.000Z',
      }),
    ];
    const threads = buildThreads(rows);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.tombstone).toBe(true);
    // The conversation under the deleted point survives.
    expect(threads[0]!.replies.map((r) => r.id)).toEqual(['r1']);
    // It still groups as a checkpoint batch (ledger_seq survives soft-delete).
    const groups = groupThreads(threads);
    expect(groups[0]!.kind).toBe('batch');
    if (groups[0]!.kind !== 'batch') throw new Error('expected a batch');
    expect(groups[0]!.threads[0]!.tombstone).toBe(true);
    expect(groups[0]!.threads[0]!.replies.map((r) => r.id)).toEqual(['r1']);
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

describe('renderReplyList (replies are permanently open)', () => {
  // Replies used to hide behind an expander and render only while a parent was
  // in the expanded set. They are now permanent: the list renders from the reply
  // data alone, with no toggle and no interaction. Walk the returned tree in the
  // hookless node style used across this file (no DOM mount needed).
  const renderReply = (reply: CommentRow): ReactElement => (
    <span key={reply.id}>{`body:${reply.id}`}</span>
  );

  it('renders every reply without any interaction, id-tagged for deep links', () => {
    const replies = [
      row({ id: 'r1', parent_comment_id: 'P', body: 'first' }),
      row({ id: 'r2', parent_comment_id: 'P', body: 'second' }),
    ];
    const tree = renderReplyList(replies, renderReply);
    const els = elements(tree);
    // The list container is present with one row per reply, in order, each row
    // carrying its stable comment DOM id.
    expect(els.some((el) => el.type === 'ul')).toBe(true);
    expect(
      els.filter((el) => el.type === 'li').map((el) => (el.props as { id: string }).id),
    ).toEqual([commentDomId('r1'), commentDomId('r2')]);
    // Both bodies are in the rendered output with no click / expand step.
    expect(text(tree)).toContain('body:r1');
    expect(text(tree)).toContain('body:r2');
  });

  it('exposes no expander or other interactive control in the list', () => {
    const tree = renderReplyList([row({ id: 'r1', parent_comment_id: 'P' })], renderReply);
    // The old "N replies" / "Hide replies" toggle is gone; the list owns no button.
    expect(elements(tree).some((el) => el.type === 'button')).toBe(false);
  });

  it('renders nothing (no empty list container) when there are no replies', () => {
    expect(renderReplyList([], renderReply)).toBeNull();
  });
});
