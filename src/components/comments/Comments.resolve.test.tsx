// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommentRow, CommentResult } from '@srtdio/comments';
import type { ToastOptions } from '@/components/ui/toast/types';

// Regression for fixes 32 and 42 on the post comments panel:
// 32: one word for done ("Resolved"); the header carries no count (the chips
//     row's "{n} of {m} resolved" is the only counter; the panel lifts counts);
//     no "settled" / "Confirmed" / "Your turn" / "With approvers" anywhere.
// 42: Resolve is ONE tap (no textarea, note, sheet or dialog); the row flips at
//     once, the bottom strip says "Resolved" with Undo for 4 seconds, and Undo
//     calls the resolve RPC with false. Same for a checkpoint. A failure reverts
//     and shows "Couldn't resolve the checkpoint. Try again." once, inline.

type ListResult = CommentResult<CommentRow[]>;

const AUTHOR = '11111111-1111-4111-8111-111111111111';

const { pageRows, checkpointRows, toasts, resolveSpy, rpcSpy, dismissSpy } = vi.hoisted(() => ({
  pageRows: { current: [] as CommentRow[] },
  checkpointRows: { current: [] as CommentRow[] },
  toasts: [] as ToastOptions[],
  resolveSpy: vi.fn(),
  rpcSpy: vi.fn(),
  dismissSpy: vi.fn(),
}));

vi.mock('@srtdio/comments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@srtdio/comments')>();
  return {
    ...actual,
    listComments: vi.fn(async (): Promise<ListResult> => ({ ok: true, data: pageRows.current })),
    resolveComment: vi.fn(async (...args: unknown[]) => resolveSpy(...args)),
  };
});
vi.mock('@srtdio/rpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@srtdio/rpc')>();
  return { ...actual, commentResolve: vi.fn(async (...args: unknown[]) => rpcSpy(...args)) };
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
  useMentionCandidates: () => ({ candidates: [] }),
}));

import { Comments, RESOLVE_FAILED_COPY } from '@/components/comments/Comments';
import type { CommentCounts } from '@/components/comments/Comments';
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

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}

async function mount(onCountsChange?: (c: CommentCounts) => void): Promise<void> {
  const record = (c: CommentCounts): void => {
    lastCounts = c;
    onCountsChange?.(c);
  };
  act(() => {
    root?.render(
      <Comments
        workspaceId="ws-1"
        entityType="post"
        entityId="post-1"
        viewerIsClient={false}
        showHeader
        onCountsChange={record}
      />,
    );
  });
  await settle();
}

function buttonByText(label: string): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll('button') ?? []).find(
    (b) => b.textContent?.trim() === label,
  );
}
function buttonByAria(label: string): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll('button') ?? []).find(
    (b) => b.getAttribute('aria-label') === label,
  );
}
/** The last counts the panel lifted to the page (the header shows none). */
let lastCounts: CommentCounts | null = null;
function lifted(): CommentCounts | null {
  return lastCounts;
}
function expectNoExtraStates(): void {
  const text = host?.textContent ?? '';
  for (const gone of ['settled', 'Confirmed', 'Your turn', 'With approvers', 'With creators']) {
    expect(text).not.toContain(gone);
  }
}
function expectNoNoteStep(): void {
  expect(host?.querySelector('textarea')).toBeNull();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(host?.textContent ?? '').not.toContain('Mark done');
}

beforeEach(() => {
  lastCounts = null;
  pageRows.current = [];
  checkpointRows.current = [];
  toasts.length = 0;
  resolveSpy.mockReset();
  rpcSpy.mockReset();
  dismissSpy.mockReset();
  resolveSpy.mockResolvedValue({ ok: true, data: undefined });
  rpcSpy.mockResolvedValue({ ok: true, data: undefined });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('fix 32: one word for done, one count', () => {
  it('lifts "{n} open / {m} resolved", shows no header count, and only Open / Resolved states', async () => {
    const accepted = '2026-02-02T00:00:00.000Z';
    pageRows.current = [
      row('c-open', 'open body'),
      row('c-done', 'done body', { resolved_at: '2026-02-01T00:00:00.000Z' }),
    ];
    // One open checkpoint, one resolved-and-accepted (formerly "Confirmed").
    checkpointRows.current = [
      row('p-1', 'point one', { ledger_seq: 1, ledger_batch_id: 'b1' }),
      row('p-2', 'point two', {
        ledger_seq: 2,
        ledger_batch_id: 'b1',
        resolved_at: '2026-02-01T00:00:00.000Z',
        accepted_at: accepted,
      }),
    ];
    const counts = vi.fn();
    await mount(counts);

    expect(lifted()).toEqual({ open: 2, resolved: 2 });
    expect(counts).toHaveBeenLastCalledWith({ open: 2, resolved: 2 });
    expectNoExtraStates();
    // The section header is "Checkpoints" with no count; the chips row owns it.
    expect(host?.querySelector('[data-open-count]')).toBeNull();
    expect(host?.querySelector('[data-comments-header]')?.textContent).not.toMatch(/resolved/);
    const text = host?.textContent ?? '';
    expect(text).toContain('Open');
    expect(text).toContain('Resolved');
  });
});

describe('fix 42: Resolve is one tap with a 4 second Undo strip', () => {
  it('resolves a plain comment in one tap, Undo sends resolved=false', async () => {
    pageRows.current = [row('c-1', 'needs a fix')];
    const counts = vi.fn();
    await mount(counts);
    expect(lifted()).toEqual({ open: 1, resolved: 0 });

    act(() => buttonByText('Resolve')?.click());

    // Instant (optimistic) and no extra step of any kind.
    expectNoNoteStep();
    expect(lifted()).toEqual({ open: 0, resolved: 1 });
    expect(counts).toHaveBeenLastCalledWith({ open: 0, resolved: 1 });
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(resolveSpy.mock.calls[0]?.[1]).toEqual({ commentId: 'c-1', resolved: true });
    expect(resolveSpy.mock.calls[0]?.[2]).toBe('trace-1');

    // The bottom strip: "Resolved" + Undo, for exactly the 4 second window.
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.title).toBe('Resolved');
    expect(toasts[0]?.action?.label).toBe('Undo');
    expect(toasts[0]?.kind).toBe('undo');
    expect(toasts[0]?.durationMs).toBe(UNDO_WINDOW_MS);
    expect(UNDO_WINDOW_MS).toBe(4000);

    await settle();
    act(() => toasts[0]?.action?.onPress());
    await settle();

    expect(resolveSpy).toHaveBeenCalledTimes(2);
    expect(resolveSpy.mock.calls[1]?.[1]).toEqual({ commentId: 'c-1', resolved: false });
    expect(lifted()).toEqual({ open: 1, resolved: 0 });
  });

  it('resolves a checkpoint in one tap through comment_resolve with no note; Undo unresolves', async () => {
    checkpointRows.current = [row('p-1', 'fix the logo', { ledger_seq: 1, ledger_batch_id: 'b1' })];
    await mount();

    const tap = buttonByAria('Resolve checkpoint 1');
    expect(tap).toBeDefined();
    expect(tap?.textContent).toBe('Resolved');
    act(() => tap?.click());

    expectNoNoteStep();
    expect(buttonByAria('Resolve checkpoint 1')).toBeUndefined();
    expect(lifted()).toEqual({ open: 0, resolved: 1 });
    expect(rpcSpy).toHaveBeenCalledTimes(1);
    const args = rpcSpy.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(args).toEqual({ p_comment_id: 'p-1', p_resolved: true, p_trace_id: 'trace-1' });
    expect(args).not.toHaveProperty('p_resolution_note');
    expect(toasts[0]?.title).toBe('Resolved');
    expect(toasts[0]?.durationMs).toBe(4000);

    await settle();
    act(() => toasts[0]?.action?.onPress());
    await settle();

    expect(rpcSpy).toHaveBeenCalledTimes(2);
    expect(rpcSpy.mock.calls[1]?.[1]).toEqual({
      p_comment_id: 'p-1',
      p_resolved: false,
      p_trace_id: 'trace-1',
    });
    expect(buttonByAria('Resolve checkpoint 1')).toBeDefined();
    expectNoExtraStates();
  });

  it('reverts and shows the one inline failure line when the resolve fails', async () => {
    pageRows.current = [row('c-1', 'needs a fix')];
    resolveSpy.mockResolvedValue({ ok: false, error: { code: 'unknown', message: 'boom' } });
    await mount();

    act(() => buttonByText('Resolve')?.click());
    await settle();

    expect(lifted()).toEqual({ open: 1, resolved: 0 });
    expect(dismissSpy).toHaveBeenCalledWith('toast-1');
    const alerts = Array.from(host?.querySelectorAll('[role="alert"]') ?? []);
    expect(alerts.map((a) => a.textContent)).toEqual([RESOLVE_FAILED_COPY]);
    expect(RESOLVE_FAILED_COPY).toBe("Couldn't resolve the checkpoint. Try again.");
  });
});
