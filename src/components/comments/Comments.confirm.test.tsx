// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommentRow, CommentResult } from '@srtdio/comments';
import type { ToastOptions } from '@/components/ui/toast/types';

// Regression for the approver's Confirm on a resolved checkpoint (Post flow B):
// the approver sees "Confirm" (44px) on a resolved point; one tap calls
// checkpoint_accept once (optimistic), the bottom strip says "Confirmed" with
// Undo for 4 seconds, and Undo calls checkpoint_accept with accepted=false. The
// row word stays "Resolved" throughout: hollow tick before, filled tick after.
// The creator never sees Confirm.

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
  useMentionCandidates: () => ({ candidates: [] }),
}));

import { Comments, CONFIRM_FAILED_COPY } from '@/components/comments/Comments';
import { UNDO_MS } from '@/lib/undo';

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

function confirmButton(seq: number): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll('button') ?? []).find(
    (b) => b.getAttribute('aria-label') === `Confirm checkpoint ${seq}`,
  );
}
function rowEl(id: string): HTMLElement | null {
  return host?.querySelector(`#comment-${id}`) ?? null;
}
function rowTick(id: string): string | null {
  return rowEl(id)?.querySelector('[data-tick]')?.getAttribute('data-tick') ?? null;
}
function rowText(id: string): string {
  return rowEl(id)?.textContent ?? '';
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

describe('approver Confirm on a resolved checkpoint', () => {
  it('one tap confirms, strip shows "Confirmed" + Undo for 4s, Undo un-accepts', async () => {
    checkpointRows.current = [point('p-1', 1)];
    await mount(true);

    // Before: "Resolved" with a HOLLOW tick, and a 44px "Confirm".
    const tap = confirmButton(1);
    expect(tap).toBeDefined();
    expect(tap?.textContent).toContain('Confirm');
    expect(tap?.className).toContain('min-h-[44px]');
    expect(tap?.className).toContain('min-w-[44px]');
    expect(rowText('p-1')).toContain('Resolved');
    expect(rowTick('p-1')).toBe('hollow');

    act(() => tap?.click());

    // Optimistic: Confirm hides, tick fills, word stays "Resolved", never "Confirmed".
    expect(confirmButton(1)).toBeUndefined();
    expect(rowTick('p-1')).toBe('filled');
    expect(rowText('p-1')).toContain('Resolved');
    expect(rowText('p-1')).not.toContain('Confirmed');

    expect(acceptSpy).toHaveBeenCalledTimes(1);
    expect(acceptSpy.mock.calls[0]?.[1]).toEqual({
      p_comment_id: 'p-1',
      p_accepted: true,
      p_trace_id: 'trace-1',
    });
    expect(resolveRpcSpy).not.toHaveBeenCalled();

    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.title).toBe('Confirmed');
    expect(toasts[0]?.action?.label).toBe('Undo');
    expect(toasts[0]?.kind).toBe('undo');
    expect(toasts[0]?.durationMs).toBe(UNDO_MS);
    expect(UNDO_MS).toBe(4000);

    await settle();
    expect(rowTick('p-1')).toBe('filled');

    act(() => toasts[0]?.action?.onPress());
    await settle();

    expect(acceptSpy).toHaveBeenCalledTimes(2);
    expect(acceptSpy.mock.calls[1]?.[1]).toEqual({
      p_comment_id: 'p-1',
      p_accepted: false,
      p_trace_id: 'trace-1',
    });
    expect(confirmButton(1)).toBeDefined();
    expect(rowTick('p-1')).toBe('hollow');
    expect(rowText('p-1')).toContain('Resolved');
  });

  it('a point already confirmed shows "Resolved" with a filled tick and no Confirm', async () => {
    checkpointRows.current = [point('p-1', 1, { accepted_at: '2026-02-02T00:00:00.000Z' })];
    await mount(true);

    expect(confirmButton(1)).toBeUndefined();
    expect(rowTick('p-1')).toBe('filled');
    expect(rowText('p-1')).toContain('Resolved');
    expect(rowText('p-1')).not.toContain('Confirmed');
  });

  it('reverts and shows the one inline failure line when the confirm fails', async () => {
    checkpointRows.current = [point('p-1', 1)];
    acceptSpy.mockResolvedValue({ ok: false, error: { code: 'unknown', message: 'boom' } });
    await mount(true);

    act(() => confirmButton(1)?.click());
    await settle();

    expect(dismissSpy).toHaveBeenCalledWith('toast-1');
    expect(confirmButton(1)).toBeDefined();
    expect(rowTick('p-1')).toBe('hollow');
    const alerts = Array.from(host?.querySelectorAll('[role="alert"]') ?? []);
    expect(alerts.map((a) => a.textContent)).toEqual([CONFIRM_FAILED_COPY]);
    expect(CONFIRM_FAILED_COPY).toBe("Couldn't confirm the checkpoint. Try again.");
  });

  it('the creator never sees Confirm; a resolved point shows the hollow tick', async () => {
    checkpointRows.current = [
      point('p-1', 1),
      point('p-2', 2, { accepted_at: '2026-02-02T00:00:00.000Z' }),
    ];
    await mount(false);

    expect(confirmButton(1)).toBeUndefined();
    expect(confirmButton(2)).toBeUndefined();
    expect(host?.textContent ?? '').not.toMatch(/\bConfirm\b/);
    expect(rowTick('p-1')).toBe('hollow');
    expect(rowTick('p-2')).toBe('filled');
    expect(acceptSpy).not.toHaveBeenCalled();
  });
});
