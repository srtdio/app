import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { CommentRow } from '@srtdio/comments';
import { PressableRow } from '@/components/ui/PressableRow';

// The comment panel pulls the chat attachment hook, whose import graph reaches
// the agora-chat browser SDK; mock it so the pure exports load in node.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import {
  annotationChip,
  CHECKPOINTS_TITLE,
  emptyListText,
  filterThreads,
  openCheckpointsLabel,
  openThreadCount,
  resolvedThreadCount,
  type ThreadRoot,
} from '@/components/comments/Comments';

// X2 comments regressions (items 2, 3, 4): the Open / All filter, the open
// count, the quoted caption line, and the composer at the end of the list.

const SRC = readFileSync(fileURLToPath(new URL('./Comments.tsx', import.meta.url)), 'utf8');

function collect(node: ReactNode, out: ReactElement[]): void {
  if (Array.isArray(node)) {
    node.forEach((child) => collect(child, out));
    return;
  }
  if (node === null || typeof node !== 'object' || !('props' in node)) return;
  const el = node as ReactElement;
  out.push(el);
  collect((el.props as { children?: ReactNode }).children, out);
}

/** A host <button> or a PressableRow (which renders one). */
function isButtonEl(el: ReactElement): boolean {
  return el.type === 'button' || el.type === PressableRow;
}

function elements(tree: ReactNode): ReactElement[] {
  const out: ReactElement[] = [];
  collect(tree, out);
  return out;
}

function text(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  if (node === null || typeof node !== 'object' || !('props' in node)) return '';
  return text((node as ReactElement<{ children?: ReactNode }>).props.children);
}

function row(id: string, resolvedAt: string | null): CommentRow {
  return {
    accepted_at: null,
    accepted_by: null,
    asked_at: null,
    asked_by: null,
    attachment_asset_ids: null,
    author_user_id: '11111111-1111-4111-8111-111111111111',
    body: `body ${id}`,
    closed_at: null,
    closed_by: null,
    created_at: '2026-01-01T00:00:00.000Z',
    deleted_at: null,
    edited_at: null,
    entity_id: 'post-1',
    entity_type: 'post',
    id,
    ledger_seq: null,
    legacy_author_name: null,
    parent_comment_id: null,
    resolution_note: null,
    resolved_at: resolvedAt,
    resolved_by: null,
    trace_id: null,
    unaccepted_at: null,
    unaccepted_by: null,
    workspace_id: 'ws-1',
  } as unknown as CommentRow;
}

function thread(id: string, resolvedAt: string | null, replies: CommentRow[] = []): ThreadRoot {
  return { comment: row(id, resolvedAt), replies, tombstone: false };
}

describe('Open / All filter (item 2)', () => {
  const threads = [
    thread('open-1', null, [row('r1', null)]),
    thread('done-1', '2026-01-02T00:00:00.000Z', [row('r2', null)]),
    thread('open-2', null),
  ];

  it('All keeps every thread; Open keeps unresolved top-level threads with their replies', () => {
    expect(filterThreads(threads, 'all').map((t) => t.comment.id)).toEqual([
      'open-1',
      'done-1',
      'open-2',
    ]);
    const open = filterThreads(threads, 'open');
    expect(open.map((t) => t.comment.id)).toEqual(['open-1', 'open-2']);
    // Replies follow their thread: an unresolved reply under a resolved root is gone with it.
    expect(open[0]?.replies.map((r) => r.id)).toEqual(['r1']);
  });

  it('the lifted counts are over live threads; the header shows no count', () => {
    expect(openThreadCount(threads)).toBe(2);
    expect(resolvedThreadCount(threads)).toBe(1);
    expect(openThreadCount([thread('done', '2026-01-02T00:00:00.000Z')])).toBe(0);
    expect(openThreadCount([{ ...thread('gone', null), tombstone: true }])).toBe(0);
    expect(
      resolvedThreadCount([{ ...thread('gone', '2026-01-02T00:00:00.000Z'), tombstone: true }]),
    ).toBe(0);
    // The header's "{n} open · {m} resolved" is gone: the chips row's
    // "{n} of {m} resolved" is the section's only counter.
    expect(SRC).not.toContain('commentCountsText');
    expect(SRC).not.toContain('data-open-count');
    expect(SRC).not.toContain(' open · ');
    expect(SRC).toContain("useState<CommentFilter>('all')");
  });

  it('the header row is opt-in (posts), so briefs keep their own heading', () => {
    expect(SRC).toContain('showHeader = false');
    expect(SRC).toContain('{showHeader ? (');
    expect(SRC).toContain(
      '<h3 className="text-base font-semibold text-fg">{CHECKPOINTS_TITLE}</h3>',
    );
    expect(CHECKPOINTS_TITLE).toBe('Checkpoints');
    expect(SRC).not.toContain('>Comments</h3>');
    expect(SRC).toContain("filterButton('open', 'Open')");
    expect(SRC).toContain("filterButton('all', 'All')");
  });
});

describe('caption quote inside the comment (item 3)', () => {
  it('a live quote is a quoted line with a left rule in fg-2 that still flashes the mark', () => {
    const onClick = vi.fn();
    const tree = annotationChip(
      'c1',
      { n: 2, quote: 'great hook', stale: false, versionNumber: 3 },
      onClick,
    );
    const button = elements(tree).find(isButtonEl)!;
    const className = (button.props as { className: string }).className;
    expect(className).toContain('border-l-2');
    expect(className).toContain('text-fg-2');
    expect(className).not.toContain('bg-annotation-bg');
    expect(className).not.toContain('rounded-md');
    expect(text(tree)).toContain('great hook');
    (button.props as { onClick: () => void }).onClick();
    expect(onClick).toHaveBeenCalledWith('c1');
  });

  it('a stale quote is inert, quoted the same way, and names the version', () => {
    const tree = annotationChip('c2', { n: 0, quote: 'old copy', stale: true, versionNumber: 1 });
    expect(elements(tree).some(isButtonEl)).toBe(false);
    const root = tree as ReactElement<{ className: string }>;
    expect(root.props.className).toContain('border-l-2');
    expect(text(tree)).toContain('copy changed · v1');
    expect(text(tree)).toContain('old copy');
  });

  it('the quote renders above the body, and the card header carries the role label and time', () => {
    const quote = SRC.indexOf('{annotationChip(');
    const body = SRC.indexOf("{comment.body.trim() !== '' ? (");
    expect(quote).toBeGreaterThan(-1);
    expect(quote).toBeLessThan(body);
    expect(SRC).toContain('data-comment-role=""');
    expect(SRC).toContain('formatRelative(comment.created_at)');
  });
});

describe('section title, empty states and the top pill', () => {
  it('posts read in checkpoints; briefs keep comments', () => {
    expect(emptyListText('post', 'all')).toBe('Checkpoints show up here.');
    expect(emptyListText('post', 'open')).toBe('Open checkpoints show up here.');
    expect(emptyListText('brief', 'all')).toBe('Comments show up here.');
    expect(emptyListText('brief', 'open')).toBe('Open comments show up here.');
  });

  it('the top pill reads "{n} open checkpoints", singular at one', () => {
    expect(openCheckpointsLabel(8)).toBe('8 open checkpoints');
    expect(openCheckpointsLabel(1)).toBe('1 open checkpoint');
  });
});

describe('action row and composer (items 3, 4)', () => {
  it('Resolve/Reopen, Reply and Copy are visible on every thread; the kebab holds only Edit / Delete', () => {
    expect(SRC).toContain('{opts.actions.canCopy ? copyControl(comment) : null}');
    expect(SRC).toContain("{isResolving ? 'Saving…' : isResolved ? 'Reopen' : 'Resolve'}");
    expect(SRC).toContain("{copyFailed ? COPY_FAILED : 'Copied'}");
    expect(SRC).not.toContain("'Comment copied'");
    // No Copy row inside the popover any more.
    expect(SRC).not.toContain('                    Copy text\n                  </button>');
  });

  it('the root composer reads "Write a comment" and sits after the list', () => {
    expect(SRC).toContain('placeholder="Write a comment"');
    const list = SRC.indexOf('<ul className="flex flex-col gap-3">');
    const composer = SRC.indexOf('<div data-comments-composer="">{composer}</div>');
    expect(list).toBeGreaterThan(-1);
    expect(composer).toBeGreaterThan(list);
  });

  it('loading is a skeleton and a failed load is ui/LoadError with Retry', () => {
    expect(SRC).toContain('<span className="sr-only">Loading comments</span>');
    expect(SRC).toContain('animate-pulse rounded bg-panel-3');
    expect(SRC).toContain('<LoadError title="comments" onRetry={() => void loadPage(0)} />');
  });
});
