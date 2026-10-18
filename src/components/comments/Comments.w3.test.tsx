// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommentRow, CommentResult } from '@srtdio/comments';
import type { UndoableAction } from '@/lib/use-undoable-action';

type ListResult = CommentResult<CommentRow[]>;

const AUTHOR = '11111111-1111-4111-8111-111111111111';

const { queue, actions, deleteSpy } = vi.hoisted(() => ({
  queue: [] as ListResult[],
  actions: [] as UndoableAction[],
  deleteSpy: vi.fn(),
}));

vi.mock('@srtdio/comments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@srtdio/comments')>();
  return {
    ...actual,
    listComments: vi.fn(async () => queue.shift() ?? { ok: true, data: [] }),
    deleteComment: vi.fn(async (...args: unknown[]) => {
      deleteSpy(...args);
      return { ok: true, data: 'deleted' };
    }),
  };
});
vi.mock('@/lib/use-undoable-action', () => ({
  useUndoableAction: () => ({
    run: (action: UndoableAction) => actions.push(action),
    flush: () => undefined,
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
        order: async () => ({ data: [], error: null }),
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

import { PAGE_SIZE } from '@srtdio/comments';
import { Comments } from '@/components/comments/Comments';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function row(id: string, body: string): CommentRow {
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
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

async function mount(): Promise<void> {
  act(() => {
    root?.render(<Comments workspaceId="ws-1" entityType="post" entityId="post-1" />);
  });
  await settle();
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label,
  );
}

beforeEach(() => {
  queue.length = 0;
  actions.length = 0;
  deleteSpy.mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('Comments W3', () => {
  it('delete hides the comment at once, Undo shows it again and sends nothing', async () => {
    queue.push({ ok: true, data: [row('c-1', 'doomed body')] });
    await mount();
    expect(host?.textContent).toContain('doomed body');

    act(() => button('Comment actions')?.click());
    act(() => button('Delete')?.click());

    expect(host?.textContent).not.toContain('doomed body');
    expect(actions).toHaveLength(1);
    expect(actions[0]?.label).toBe('Comment deleted');
    expect(deleteSpy).not.toHaveBeenCalled();

    act(() => actions[0]?.revert?.());
    expect(host?.textContent).toContain('doomed body');
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('a failed older page keeps the list and offers Retry at the bottom', async () => {
    const full = Array.from({ length: PAGE_SIZE }, (_u, i) => row(`c-${i}`, `body ${i}`));
    queue.push({ ok: true, data: full });
    queue.push({ ok: false, error: { code: 'unknown', message: 'fetch failed' } });
    await mount();

    act(() => button('Load more')?.click());
    await settle();

    expect(host?.textContent).toContain('body 0');
    expect(host?.textContent).toContain("Couldn't load older comments.");
    expect(host?.textContent).not.toContain('fetch failed');
    expect(button('Retry')).toBeDefined();
  });

  it('an initial load failure shows plain copy with Retry, never the raw error', async () => {
    queue.push({ ok: false, error: { code: 'unknown', message: 'PGRST boom' } });
    queue.push({ ok: true, data: [row('c-1', 'back again')] });
    await mount();

    expect(host?.textContent).toContain("Couldn't load comments.");
    expect(host?.textContent).not.toContain('PGRST');
    act(() => button('Retry')?.click());
    await settle();
    expect(host?.textContent).toContain('back again');
  });
});
