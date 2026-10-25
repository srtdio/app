// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommentRow, CommentResult } from '@srtdio/comments';

type ListResult = CommentResult<CommentRow[]>;

const { pending, fromSpy } = vi.hoisted(() => ({
  pending: [] as Array<(result: ListResult) => void>,
  fromSpy: vi.fn(),
}));

vi.mock('@srtdio/comments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@srtdio/comments')>();
  return {
    ...actual,
    listComments: vi.fn(
      () =>
        new Promise<ListResult>((resolve) => {
          pending.push(resolve);
        }),
    ),
  };
});
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: null } }) },
    from: (table: string) => {
      fromSpy(table);
      const chain = {
        select: () => chain,
        eq: () => chain,
        not: () => chain,
        is: () => chain,
        order: async () => ({ data: [], error: null }),
      };
      return chain;
    },
  },
}));
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
vi.mock('@/components/comments/commentProfiles', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/comments/commentProfiles')>();
  return { ...actual, fetchCommentProfiles: async () => new Map() };
});

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
    author_user_id: '11111111-1111-4111-8111-111111111111',
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

function render(refreshSignal: number): void {
  act(() => {
    root?.render(
      <Comments
        workspaceId="ws-1"
        entityType="post"
        entityId="post-1"
        refreshSignal={refreshSignal}
      />,
    );
  });
}

async function resolveLoad(index: number, rows: CommentRow[]): Promise<void> {
  await act(async () => {
    pending[index]?.({ ok: true, data: rows });
    await Promise.resolve();
  });
}

beforeEach(() => {
  pending.length = 0;
  fromSpy.mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('Comments page-0 stale-response guard', () => {
  it('applies only the newest page-0 response when two resolve out of order', async () => {
    render(0);
    render(1);
    expect(pending).toHaveLength(2);

    await resolveLoad(1, [row('c-new', 'newest body')]);
    await resolveLoad(0, [row('c-old', 'stale body')]);

    const text = host?.textContent ?? '';
    expect(text).toContain('newest body');
    expect(text).not.toContain('stale body');
    // The stale load bailed before its checkpoint read.
    expect(fromSpy.mock.calls.filter(([t]) => t === 'comments')).toHaveLength(1);
  });

  it('sets no state when unmounted mid-load', async () => {
    render(0);
    expect(pending).toHaveLength(1);
    act(() => root?.unmount());
    root = null;

    await resolveLoad(0, [row('c-1', 'late body')]);

    // The load stopped at the guard: no checkpoint read, nothing rendered.
    expect(fromSpy).not.toHaveBeenCalledWith('comments');
    expect(host?.textContent ?? '').toBe('');
  });
});
