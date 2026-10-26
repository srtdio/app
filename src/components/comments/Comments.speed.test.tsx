// @vitest-environment jsdom
// Comments speed (Speedy A, item 8):
// - page zero reads the list and the post's checkpoints IN PARALLEL (both
//   requests are issued before either resolves);
// - the skeleton shows only on the first load: a send, edit, delete or reopen
//   writes the row in place at once (from the RPC's id + the known input) and
//   the page-zero refetch runs silently in the background, so the landed row is
//   visible BEFORE that refetch settles and "Loading comments" never returns.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommentRow, CommentResult } from '@srtdio/comments';
import type { UndoableAction } from '@/lib/use-undoable-action';

type ListResult = CommentResult<CommentRow[]>;
type CheckpointResult = { data: CommentRow[]; error: null };

const AUTHOR = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const h = vi.hoisted(() => ({
  viewerId: '',
  /** Every read in the order it was ISSUED. */
  issued: [] as string[],
  /** Rows the FIRST list read returns at once. */
  firstRows: [] as CommentRow[],
  /** Rows the first checkpoint read returns at once. */
  firstCheckpoints: [] as CommentRow[],
  /** When set, list reads park here instead of resolving. */
  holdList: false,
  heldList: [] as Array<(result: ListResult) => void>,
  holdCheckpoints: false,
  heldCheckpoints: [] as Array<(result: CheckpointResult) => void>,
  listCalls: 0,
  actions: [] as UndoableAction[],
  createComment: vi.fn(),
  editComment: vi.fn(),
  deleteComment: vi.fn(),
  resolveComment: vi.fn(),
}));

vi.mock('@srtdio/comments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@srtdio/comments')>();
  return {
    ...actual,
    listComments: vi.fn((): Promise<ListResult> => {
      h.issued.push('list');
      h.listCalls += 1;
      if (h.holdList) {
        return new Promise<ListResult>((resolve) => {
          h.heldList.push(resolve);
        });
      }
      return Promise.resolve({ ok: true, data: h.firstRows });
    }),
    createComment: h.createComment,
    editComment: h.editComment,
    deleteComment: h.deleteComment,
    resolveComment: h.resolveComment,
  };
});
vi.mock('@/lib/use-undoable-action', () => ({
  useUndoableAction: () => ({
    run: (action: UndoableAction) => h.actions.push(action),
    flush: () => undefined,
  }),
}));
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { user: { id: h.viewerId } } } }) },
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        not: () => chain,
        is: () => chain,
        in: async () => ({ data: [], error: null }),
        // The checkpoint read is the only .order() read on comments here.
        order: (): Promise<CheckpointResult> => {
          if (table !== 'comments') return Promise.resolve({ data: [], error: null });
          h.issued.push('checkpoints');
          if (h.holdCheckpoints) {
            return new Promise<CheckpointResult>((resolve) => {
              h.heldCheckpoints.push(resolve);
            });
          }
          return Promise.resolve({ data: h.firstCheckpoints, error: null });
        },
      };
      return chain;
    },
  },
}));
vi.mock('@/lib/people-names', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/people-names')>();
  return { ...actual, resolvePeople: async () => true };
});
vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => false,
  useHoverPointer: () => false,
}));
vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => () => 'trace-1' }));
vi.mock('@/lib/chat/use-chat-attachments', () => ({
  useCommentAttachments: () => ({
    canAttach: false,
    presignEnabled: false,
    presignCache: null,
    uploadFile: async () => ({ ok: false, message: 'off' }),
  }),
}));
vi.mock('@/lib/workspace-members', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspace-members')>()),
  useMentionCandidates: () => ({
    candidates: [
      { id: AUTHOR, name: 'Ada Author', username: 'ada', role: 'agency', avatarUrl: null },
      { id: OTHER, name: 'Omar Other', username: 'omar', role: 'agency', avatarUrl: null },
    ],
  }),
}));

import { Comments, localCommentRow, upsertRows } from '@/components/comments/Comments';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function row(id: string, body: string, extra: Partial<CommentRow> = {}): CommentRow {
  return {
    accepted_at: null,
    accepted_by: null,
    asked_at: null,
    asked_by: null,
    attachment_asset_ids: null,
    author_user_id: AUTHOR,
    body,
    closed_at: null,
    closed_by: null,
    created_at: '2026-01-01T00:00:00.000Z',
    deleted_at: null,
    edited_at: null,
    entity_id: 'post-1',
    entity_type: 'post',
    id,
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
    workspace_id: 'ws-1',
    ...extra,
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

async function mount(): Promise<void> {
  act(() => {
    root?.render(<Comments workspaceId="ws-1" entityType="post" entityId="post-1" showHeader />);
  });
  await settle();
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label,
  );
}
function rowEl(id: string): HTMLElement | null {
  return host?.querySelector(`#comment-${id}`) ?? null;
}
const skeletonShown = (): boolean => (host?.textContent ?? '').includes('Loading comments');

/** From here on every list read parks until the test releases it. */
function holdRefetch(): void {
  h.holdList = true;
}

beforeEach(() => {
  h.viewerId = AUTHOR;
  h.issued.length = 0;
  h.firstRows = [];
  h.firstCheckpoints = [];
  h.holdList = false;
  h.heldList.length = 0;
  h.holdCheckpoints = false;
  h.heldCheckpoints.length = 0;
  h.listCalls = 0;
  h.actions.length = 0;
  for (const fn of [h.createComment, h.editComment, h.deleteComment, h.resolveComment]) {
    fn.mockReset();
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('page zero reads the list and the checkpoints in parallel', () => {
  it('issues both reads before either resolves', async () => {
    h.holdList = true;
    h.holdCheckpoints = true;
    await mount();
    // Both requests are out while neither has answered: one round trip, not two.
    expect(h.issued).toEqual(expect.arrayContaining(['list', 'checkpoints']));
    expect(h.heldList).toHaveLength(1);
    expect(h.heldCheckpoints).toHaveLength(1);
    expect(skeletonShown()).toBe(true);

    await act(async () => {
      h.heldCheckpoints[0]?.({
        data: [row('p-1', 'a checkpoint', { ledger_seq: 1 })],
        error: null,
      });
      h.heldList[0]?.({ ok: true, data: [row('c-1', 'a comment')] });
    });
    await settle();
    expect(skeletonShown()).toBe(false);
    expect(host?.textContent).toContain('a comment');
    expect(host?.textContent).toContain('a checkpoint');
  });
});

describe('writes update in place; the refetch is silent', () => {
  it('send: the reply shows before the background refetch lands, with no skeleton', async () => {
    h.viewerId = OTHER;
    h.firstCheckpoints = [row('p-1', 'checkpoint 1', { ledger_seq: 1, ledger_batch_id: 'b1' })];
    h.createComment.mockResolvedValue({ ok: true, data: 'new-reply' });
    await mount();
    expect(skeletonShown()).toBe(false);

    const reply = Array.from(rowEl('p-1')?.querySelectorAll('button') ?? []).find(
      (b) => b.textContent?.trim() === 'Reply' && !b.hasAttribute('data-reply-to-reply'),
    );
    act(() => reply?.click());
    await settle();

    holdRefetch();
    const submit = Array.from(host?.querySelectorAll('button') ?? [])
      .filter((b) => b.textContent?.trim() === 'Reply')
      .pop();
    act(() => submit?.click());
    await settle();

    expect(h.createComment).toHaveBeenCalledTimes(1);
    // The background refetch is out but has not answered: the reply is already
    // on screen and the skeleton never came back.
    expect(h.heldList).toHaveLength(1);
    expect(rowEl('new-reply')).not.toBeNull();
    expect(skeletonShown()).toBe(false);

    await act(async () => {
      h.heldList[0]?.({
        ok: true,
        data: [
          row('new-reply', '@[11111111-1111-4111-8111-111111111111]', { parent_comment_id: 'p-1' }),
        ],
      });
    });
    await settle();
    expect(rowEl('new-reply')).not.toBeNull();
    expect(skeletonShown()).toBe(false);
  });

  it('edit: the saved body shows before the refetch lands, with no skeleton', async () => {
    h.firstRows = [row('c-1', 'old body')];
    h.editComment.mockResolvedValue({ ok: true, data: 'c-1' });
    await mount();

    act(() => button('Comment actions')?.click());
    act(() => button('Edit')?.click());
    const box = host?.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Edit comment body"]',
    );
    expect(box).toBeTruthy();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(box, 'new body');
      box?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    holdRefetch();
    act(() => button('Save')?.click());
    await settle();

    expect(h.editComment).toHaveBeenCalledTimes(1);
    expect(h.heldList).toHaveLength(1);
    expect(host?.textContent).toContain('new body');
    expect(host?.textContent).not.toContain('old body');
    expect(skeletonShown()).toBe(false);
  });

  it('delete: the landed delete stays gone with no skeleton while the refetch runs', async () => {
    h.firstRows = [row('c-1', 'doomed body')];
    h.deleteComment.mockResolvedValue({ ok: true, data: 'c-1' });
    await mount();

    act(() => button('Comment actions')?.click());
    act(() => button('Delete')?.click());
    expect(h.actions).toHaveLength(1);

    holdRefetch();
    await act(async () => {
      await h.actions[0]?.commit();
    });
    await settle();

    expect(h.deleteComment).toHaveBeenCalledTimes(1);
    expect(h.heldList).toHaveLength(1);
    expect(host?.textContent).not.toContain('doomed body');
    expect(skeletonShown()).toBe(false);
  });

  it('reopen: the thread reads open at once with no skeleton while the refetch runs', async () => {
    h.firstRows = [row('c-1', 'done thing', { resolved_at: '2026-02-01T00:00:00.000Z' })];
    h.resolveComment.mockResolvedValue({ ok: true, data: undefined });
    await mount();
    expect(button('Reopen')).toBeDefined();

    holdRefetch();
    act(() => button('Reopen')?.click());
    await settle();

    expect(h.resolveComment).toHaveBeenCalledTimes(1);
    expect(h.heldList).toHaveLength(1);
    expect(button('Reopen')).toBeUndefined();
    expect(button('Resolve')).toBeDefined();
    expect(skeletonShown()).toBe(false);
  });

  it('a failed silent refetch keeps the rows and shows no load error', async () => {
    h.firstRows = [row('c-1', 'old body')];
    h.editComment.mockResolvedValue({ ok: true, data: 'c-1' });
    await mount();
    act(() => button('Comment actions')?.click());
    act(() => button('Edit')?.click());
    holdRefetch();
    act(() => button('Save')?.click());
    await settle();
    await act(async () => {
      h.heldList[0]?.({ ok: false, error: { code: 'unknown', message: 'boom' } });
    });
    await settle();
    expect(host?.textContent).toContain('old body');
    expect(host?.textContent).not.toContain("Couldn't load");
    expect(skeletonShown()).toBe(false);
  });
});

describe('localCommentRow / upsertRows', () => {
  it('builds the landed row from the known input and puts it first, replacing a same-id row', () => {
    const landed = localCommentRow({
      id: 'n1',
      workspaceId: 'ws-1',
      entityType: 'post',
      entityId: 'post-1',
      authorUserId: AUTHOR,
      body: 'hi @[22222222-2222-4222-8222-222222222222]',
      attachmentVersionIds: [],
      parentCommentId: 'p-1',
      ledgerSeq: null,
      nowIso: '2026-03-01T00:00:00.000Z',
    });
    expect(landed).toMatchObject({
      id: 'n1',
      author_user_id: AUTHOR,
      parent_comment_id: 'p-1',
      created_at: '2026-03-01T00:00:00.000Z',
      deleted_at: null,
      resolved_at: null,
      mentions: [OTHER],
    });
    const rows = upsertRows([row('n1', 'stale'), row('c-1', 'x')], [landed]);
    expect(rows.map((r) => r.id)).toEqual(['n1', 'c-1']);
    expect(rows[0]?.body).toContain('hi');
  });
});
