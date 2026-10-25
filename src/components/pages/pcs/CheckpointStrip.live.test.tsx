// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommentRow, CommentResult } from '@srtdio/comments';
import type { ToastOptions } from '@/components/ui/toast/types';

// Regression: the checkpoint strip under the comments header repaints in the
// same render as the row. Confirm fills the matching strip chip immediately (no
// refetch, no refresh signal); Undo hollows it again.

type ListResult = CommentResult<CommentRow[]>;

const AUTHOR = '11111111-1111-4111-8111-111111111111';
const RESOLVED = '2026-02-01T00:00:00.000Z';

const { checkpointRows, toasts, acceptSpy, resolveRpcSpy, dismissSpy } = vi.hoisted(() => ({
  checkpointRows: { current: [] as CommentRow[] },
  toasts: [] as ToastOptions[],
  acceptSpy: vi.fn(),
  resolveRpcSpy: vi.fn(),
  dismissSpy: vi.fn(),
}));

vi.mock('@srtdio/comments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@srtdio/comments')>();
  return {
    ...actual,
    listComments: vi.fn(async (): Promise<ListResult> => ({ ok: true, data: [] })),
  };
});
vi.mock('@srtdio/rpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@srtdio/rpc')>();
  return {
    ...actual,
    checkpointAccept: vi.fn(async (...args: unknown[]) => acceptSpy(...args)),
    commentResolve: vi.fn(async (...args: unknown[]) => resolveRpcSpy(...args)),
  };
});
vi.mock('@/components/ui/toast', () => ({
  useOptionalToast: () => ({
    show: (options: ToastOptions) => {
      toasts.push(options);
      return `toast-${toasts.length}`;
    },
    dismiss: (id: string) => dismissSpy(id),
  }),
}));
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { user: { id: AUTHOR } } } }) },
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        not: () => chain,
        is: () => chain,
        in: async () => ({ data: [], error: null }),
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
vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => false,
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
  useMentionCandidates: () => ({ candidates: [] }),
}));

import { Comments } from '@/components/comments/Comments';
import { CheckpointStrip } from '@/components/pages/pcs/CheckpointStrip';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function point(id: string, seq: number, extra: Partial<CommentRow> = {}): CommentRow {
  return {
    accepted_at: null,
    accepted_by: null,
    asked_at: null,
    asked_by: null,
    attachment_asset_ids: null,
    author_user_id: AUTHOR,
    body: `point ${seq}`,
    closed_at: null,
    closed_by: null,
    created_at: '2026-01-01T00:00:00.000Z',
    deleted_at: null,
    edited_at: null,
    entity_id: 'post-1',
    entity_type: 'post',
    id,
    ledger_batch_id: 'b1',
    ledger_seq: seq,
    legacy_author_name: null,
    legacy_author_email: null,
    mentions: null,
    parent_comment_id: null,
    resolution_note: null,
    resolved_at: RESOLVED,
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
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}

async function mount(): Promise<void> {
  act(() => {
    root?.render(
      <Comments
        workspaceId="ws-1"
        entityType="post"
        entityId="post-1"
        viewerIsClient
        showHeader
        belowHeader={
          <CheckpointStrip workspaceId="ws-1" postId="post-1" viewerIsClient refreshSignal={0} />
        }
      />,
    );
  });
  await settle();
}

function confirmButton(seq: number): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll('button') ?? []).find(
    (b) => b.getAttribute('aria-label') === `Confirm checkpoint ${seq}`,
  );
}
function stripTick(seq: number): string | null {
  const chip = Array.from(host?.querySelectorAll('[data-checkpoint-strip] button') ?? []).find(
    (b) => b.getAttribute('aria-label') === `Jump to checkpoint ${seq}`,
  );
  return chip?.querySelector('[data-chip-tick]')?.getAttribute('data-chip-tick') ?? null;
}

beforeEach(() => {
  checkpointRows.current = [];
  toasts.length = 0;
  acceptSpy.mockReset();
  resolveRpcSpy.mockReset();
  dismissSpy.mockReset();
  acceptSpy.mockResolvedValue({ ok: true, data: undefined });
  resolveRpcSpy.mockResolvedValue({ ok: true, data: undefined });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('checkpoint strip follows the list live', () => {
  it('Confirm fills the matching strip chip in the same paint; Undo hollows it again', async () => {
    checkpointRows.current = [point('p-1', 1), point('p-2', 2)];
    await mount();

    expect(stripTick(1)).toBe('hollow');
    expect(stripTick(2)).toBe('hollow');

    // Synchronous check right after the tap: no settle, no refetch.
    act(() => confirmButton(1)?.click());
    expect(stripTick(1)).toBe('filled');
    expect(stripTick(2)).toBe('hollow');

    await settle();
    expect(stripTick(1)).toBe('filled');

    act(() => toasts[0]?.action?.onPress());
    await settle();
    expect(stripTick(1)).toBe('hollow');
    expect(stripTick(2)).toBe('hollow');
  });
});
