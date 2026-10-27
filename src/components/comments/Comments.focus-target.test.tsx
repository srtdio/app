// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommentRow } from '@srtdio/comments';

// A link to a reply whose thread root is beyond page zero: the reply and its
// root are read by id, merged into the list, rendered, and the reply is tinted.

const { byIds } = vi.hoisted(() => ({ byIds: vi.fn() }));

vi.mock('@srtdio/comments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@srtdio/comments')>();
  return {
    ...actual,
    listComments: vi.fn(async () => ({
      ok: true,
      data: Array.from({ length: actual.PAGE_SIZE }, (_, i) => row(`page0-${i}`, `newer ${i}`)),
    })),
    getCommentsByIds: byIds,
  };
});
vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: null } }) } },
}));
vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => false,
  useHoverPointer: () => false,
  prefersReducedMotion: () => true,
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

import { commentDomId, Comments } from '@/components/comments/Comments';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function row(id: string, body: string, over: Partial<CommentRow> = {}): CommentRow {
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
    created_at: '2026-06-01T00:00:00.000Z',
    deleted_at: null,
    edited_at: null,
    entity_id: 'brief-1',
    entity_type: 'brief',
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
    ...over,
  };
}

const ROOT = row('old-root', 'the old root', { created_at: '2026-01-01T00:00:00.000Z' });
const REPLY = row('old-reply', 'the linked reply', {
  created_at: '2026-01-02T00:00:00.000Z',
  parent_comment_id: 'old-root',
});

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

beforeEach(() => {
  byIds.mockReset();
  byIds.mockImplementation(async (_client: unknown, input: { ids: string[] }) => ({
    ok: true,
    data: [ROOT, REPLY].filter((r) => input.ids.includes(r.id)),
  }));
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('Comments: a linked reply whose root is beyond page zero', () => {
  it('reads the reply and its root by id, renders the thread and tints the reply', async () => {
    act(() => {
      root?.render(
        <Comments
          workspaceId="ws-1"
          entityType="brief"
          entityId="brief-1"
          focusCommentId="old-reply"
        />,
      );
    });
    await flush();

    expect(byIds).toHaveBeenCalledTimes(2);
    expect(byIds.mock.calls[0]?.[1]).toMatchObject({
      workspace_id: 'ws-1',
      entity_type: 'brief',
      entity_id: 'brief-1',
      ids: ['old-reply'],
    });
    expect(byIds.mock.calls[1]?.[1]).toMatchObject({ ids: ['old-root'] });

    const rootRow = document.getElementById(commentDomId('old-root'));
    const replyRow = document.getElementById(commentDomId('old-reply'));
    expect(rootRow).not.toBeNull();
    expect(replyRow).not.toBeNull();
    expect(rootRow?.contains(replyRow ?? null)).toBe(true);
    expect(replyRow?.hasAttribute('data-jump-glow')).toBe(true);
  });

  it('a deleted target is never rendered and the page stays open', async () => {
    byIds.mockImplementation(async () => ({
      ok: true,
      data: [row('gone', 'deleted', { deleted_at: '2026-06-02T00:00:00.000Z' })],
    }));
    act(() => {
      root?.render(
        <Comments workspaceId="ws-1" entityType="brief" entityId="brief-1" focusCommentId="gone" />,
      );
    });
    await flush();
    expect(byIds).toHaveBeenCalledTimes(1);
    expect(document.getElementById(commentDomId('gone'))).toBeNull();
    expect(document.getElementById(commentDomId('page0-0'))).not.toBeNull();
  });
});
