// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommentRow, CommentResult } from '@srtdio/comments';
import type { ToastOptions } from '@/components/ui/toast/types';

// Checkpoints in the post comments panel:
// - each checkpoint has a checkbox (44px hit area); ONE tap resolves it: the box
//   ticks and reads "Resolved", no box / note / confirm opens, Undo for 4s;
// - everyone can reply inside a checkpoint, clients included;
// - a reply to a reply posts to the checkpoint root (one reply level) and the
//   composer opens with the @Name of the person replied to, sent in p_mentions;
// - nothing is pre-filled except that @Name ("Not done" and its sentence are gone).

type ListResult = CommentResult<CommentRow[]>;

const AUTHOR = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const CLIENT = '33333333-3333-4333-8333-333333333333';
const RESOLVED = '2026-02-01T00:00:00.000Z';

const { pageRows, checkpointRows, viewer, toasts, rpcSpy, createSpy } = vi.hoisted(() => ({
  pageRows: { current: [] as CommentRow[] },
  checkpointRows: { current: [] as CommentRow[] },
  viewer: { id: '' },
  toasts: [] as ToastOptions[],
  rpcSpy: vi.fn(),
  createSpy: vi.fn(),
}));

vi.mock('@srtdio/comments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@srtdio/comments')>();
  return {
    ...actual,
    listComments: vi.fn(async (): Promise<ListResult> => ({ ok: true, data: pageRows.current })),
  };
});
vi.mock('@srtdio/rpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@srtdio/rpc')>();
  return {
    ...actual,
    commentResolve: vi.fn(async (...args: unknown[]) => rpcSpy(...args)),
    commentCreate: vi.fn(async (...args: unknown[]) => createSpy(...args)),
  };
});
vi.mock('@/components/ui/toast', () => ({
  useOptionalToast: () => ({
    show: (options: ToastOptions) => {
      toasts.push(options);
      return `toast-${toasts.length}`;
    },
    dismiss: () => undefined,
  }),
}));
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { user: { id: viewer.id } } } }) },
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        not: () => chain,
        is: () => chain,
        // createComment validates mentions against active members.
        in: async () => ({
          data:
            table === 'workspace_members'
              ? [{ user_id: AUTHOR }, { user_id: OTHER }, { user_id: CLIENT }]
              : [],
          error: null,
        }),
        order: async () => ({ data: checkpointRows.current, error: null }),
      };
      return chain;
    },
  },
}));
vi.mock('@/lib/people-names', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/people-names')>();
  return { ...actual, resolvePeople: async () => true };
});
vi.mock('@/lib/use-media-query', () => ({ useMediaQuery: () => false }));
vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => () => 'trace-1' }));
vi.mock('@/lib/chat/use-chat-attachments', () => ({
  useCommentAttachments: () => ({
    canAttach: false,
    presignEnabled: false,
    presignCache: null,
    uploadFile: async () => ({ ok: false, message: 'off' }),
  }),
}));
vi.mock('@/components/comments/useMentionCandidates', () => ({
  useMentionCandidates: () => ({
    candidates: [
      { id: AUTHOR, name: 'Ada Author', username: 'ada', role: 'agency', avatarUrl: null },
      { id: OTHER, name: 'Omar Other', username: 'omar', role: 'agency', avatarUrl: null },
      { id: CLIENT, name: 'Cara Client', username: 'cara', role: 'client', avatarUrl: null },
    ],
  }),
}));

import { Comments } from '@/components/comments/Comments';
import { UNDO_WINDOW_MS } from '@/lib/use-undoable-action';

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

function checkpoint(id: string, seq: number, extra: Partial<CommentRow> = {}): CommentRow {
  return row(id, `checkpoint ${seq}`, { ledger_seq: seq, ledger_batch_id: 'b1', ...extra });
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

async function mount(viewerIsClient: boolean): Promise<void> {
  act(() => {
    root?.render(
      <Comments
        workspaceId="ws-1"
        entityType="post"
        entityId="post-1"
        viewerIsClient={viewerIsClient}
        showHeader
      />,
    );
  });
  await settle();
}

function buttons(): HTMLButtonElement[] {
  return Array.from(host?.querySelectorAll('button') ?? []);
}
function byAria(label: string): HTMLButtonElement | undefined {
  return buttons().find((b) => b.getAttribute('aria-label') === label);
}
function rowEl(id: string): HTMLElement | null {
  return host?.querySelector(`#comment-${id}`) ?? null;
}
/** The checkpoint row's own Reply (not a reply's, not the composer's submit). */
function checkpointReply(id: string): HTMLButtonElement | undefined {
  return Array.from(rowEl(id)?.querySelectorAll('button') ?? []).find(
    (b) => b.textContent?.trim() === 'Reply' && !b.hasAttribute('data-reply-to-reply'),
  );
}
/** The open reply composer's submit (labelled "Reply"; the last such button). */
function composerSubmit(): HTMLButtonElement | undefined {
  const all = buttons().filter((b) => b.textContent?.trim() === 'Reply');
  return all[all.length - 1];
}
function editor(): HTMLElement | null {
  return host?.querySelector('[contenteditable="true"]') ?? null;
}
function createArgs(call = 0): Record<string, unknown> {
  return (createSpy.mock.calls[call]?.[1] ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  pageRows.current = [];
  checkpointRows.current = [];
  viewer.id = AUTHOR;
  toasts.length = 0;
  rpcSpy.mockReset();
  createSpy.mockReset();
  rpcSpy.mockResolvedValue({ ok: true, data: undefined });
  createSpy.mockResolvedValue({ ok: true, data: 'new-reply' });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('checkpoint checkbox', () => {
  it('resolves in one tap: the box ticks and reads "Resolved", Undo for 4s', async () => {
    checkpointRows.current = [checkpoint('p-1', 1)];
    await mount(false);

    const box = byAria('Resolve checkpoint 1');
    expect(box).toBeDefined();
    expect(box?.getAttribute('role')).toBe('checkbox');
    expect(box?.getAttribute('aria-checked')).toBe('false');
    expect(box?.className).toContain('min-h-[44px]');
    expect(box?.className).toContain('min-w-[44px]');
    expect(box?.querySelector('[data-tick]')?.getAttribute('data-tick')).toBe('open');

    act(() => box?.click());

    // One tap: no textarea, note, sheet or dialog.
    expect(host?.querySelector('textarea')).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    // The box is ticked and its word is "Resolved".
    expect(byAria('Resolve checkpoint 1')).toBeUndefined();
    const ticked = rowEl('p-1')?.querySelector('[data-checkpoint-box]');
    expect(ticked?.querySelector('[data-tick]')?.getAttribute('data-tick')).not.toBe('open');
    expect(ticked?.textContent).toBe('Resolved');

    expect(rpcSpy).toHaveBeenCalledTimes(1);
    expect(rpcSpy.mock.calls[0]?.[1]).toEqual({
      p_comment_id: 'p-1',
      p_resolved: true,
      p_trace_id: 'trace-1',
    });
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.title).toBe('Resolved');
    expect(toasts[0]?.action?.label).toBe('Undo');
    expect(toasts[0]?.durationMs).toBe(UNDO_WINDOW_MS);
    expect(UNDO_WINDOW_MS).toBe(4000);
  });

  it('keeps the approver one-tap Confirm on a creator-resolved checkpoint, and no "Not done"', async () => {
    viewer.id = CLIENT;
    checkpointRows.current = [checkpoint('p-1', 1, { resolved_at: RESOLVED })];
    await mount(true);

    expect(byAria('Confirm checkpoint 1')).toBeDefined();
    expect(byAria('Resolve checkpoint 1')).toBeUndefined();
    const box = rowEl('p-1')?.querySelector('[data-checkpoint-box]');
    expect(box?.textContent).toBe('Resolved');
    expect(box?.querySelector('[data-tick]')?.getAttribute('data-tick')).toBe('hollow');
    expect(host?.textContent ?? '').not.toContain('Not done');
    expect(host?.textContent ?? '').not.toContain('gone back to the creators');
  });
});

describe('replies inside a checkpoint', () => {
  it('a client can reply on a checkpoint; it posts to the checkpoint', async () => {
    viewer.id = CLIENT;
    checkpointRows.current = [checkpoint('p-1', 1)];
    await mount(true);

    const reply = checkpointReply('p-1');
    expect(reply).toBeDefined();
    act(() => reply?.click());
    await settle();

    // Nothing pre-filled except the @Name of the checkpoint's author.
    expect(editor()?.textContent?.trim()).toBe('@ada');

    act(() => composerSubmit()?.click());
    await settle();

    expect(createSpy).toHaveBeenCalledTimes(1);
    const args = createArgs();
    expect(args['p_parent_comment_id']).toBe('p-1');
    expect(args['p_entity_id']).toBe('post-1');
    expect(args['p_mentions']).toEqual([AUTHOR]);
    expect(args['p_trace_id']).toBe('trace-1');
  });

  it('a reply to a reply posts to the checkpoint root with an @mention of that person', async () => {
    viewer.id = CLIENT;
    checkpointRows.current = [checkpoint('p-1', 1)];
    pageRows.current = [
      row('r-1', 'on it', {
        author_user_id: OTHER,
        parent_comment_id: 'p-1',
        created_at: '2026-01-02T00:00:00.000Z',
      }),
    ];
    await mount(true);

    const replyToReply = rowEl('r-1')?.querySelector<HTMLButtonElement>('[data-reply-to-reply]');
    expect(replyToReply).toBeTruthy();
    expect(replyToReply?.className).toContain('min-h-[44px]');
    act(() => replyToReply?.click());
    await settle();

    // The composer opens with the replied-to person's @Name, nothing else.
    const chip = editor()?.querySelector('[data-mention-id]');
    expect(chip?.getAttribute('data-mention-id')).toBe(OTHER);
    expect(editor()?.textContent?.trim()).toBe('@omar');

    act(() => composerSubmit()?.click());
    await settle();

    expect(createSpy).toHaveBeenCalledTimes(1);
    const args = createArgs();
    // One reply level on the server: the parent is the checkpoint root, never r-1.
    expect(args['p_parent_comment_id']).toBe('p-1');
    expect(args['p_mentions']).toEqual(expect.arrayContaining([OTHER]));
    expect(String(args['p_body'])).toContain(`@[${OTHER}]`);
  });
});
