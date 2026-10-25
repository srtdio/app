// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommentRow, CommentResult } from '@srtdio/comments';

// One checkpoint read per post page: with `sharedCheckpoints` (the post page's
// read) Comments never reads the checkpoints itself, renders the host's rows,
// and asks the host to re-read where it would have re-read on its own (Retry).
// Without the prop (brief detail, chat, any other host) it still reads them
// itself after its page-zero list lands, exactly as before.

type ListResult = CommentResult<CommentRow[]>;

const AUTHOR = '11111111-1111-4111-8111-111111111111';

const h = vi.hoisted(() => ({
  checkpointRows: [] as CommentRow[],
  tables: [] as string[],
  listOk: true,
}));

vi.mock('@srtdio/comments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@srtdio/comments')>();
  return {
    ...actual,
    listComments: vi.fn(
      async (): Promise<ListResult> =>
        h.listOk
          ? { ok: true, data: [] }
          : { ok: false, error: { code: 'unknown', message: 'boom' } },
    ),
  };
});
vi.mock('@/components/ui/toast', () => ({
  useOptionalToast: () => ({ show: () => 'toast-1', dismiss: () => {} }),
}));
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { user: { id: AUTHOR } } } }) },
    from: (table: string) => {
      h.tables.push(table);
      const chain = {
        select: () => chain,
        eq: () => chain,
        not: () => chain,
        is: () => chain,
        in: async () => ({ data: [], error: null }),
        order: async () => ({ data: h.checkpointRows, error: null }),
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

import { Comments, type SharedCheckpoints } from '@/components/comments/Comments';
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

function commentReads(): number {
  return h.tables.filter((t) => t === 'comments').length;
}

function chips(): string[] {
  return Array.from(host?.querySelectorAll('[data-checkpoint-strip] button') ?? []).map(
    (b) => b.getAttribute('aria-label') ?? '',
  );
}

async function mountShared(shared: SharedCheckpoints): Promise<void> {
  act(() => {
    root?.render(
      <Comments
        workspaceId="ws-1"
        entityType="post"
        entityId="post-1"
        showHeader
        sharedCheckpoints={shared}
        belowHeader={
          <CheckpointStrip
            workspaceId="ws-1"
            postId="post-1"
            viewerIsClient={false}
            refreshSignal={0}
            checkpoints={shared.rows}
          />
        }
      />,
    );
  });
  await settle();
}

beforeEach(() => {
  h.checkpointRows = [];
  h.tables = [];
  h.listOk = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('Comments without sharedCheckpoints (every other host)', () => {
  it('still reads the checkpoints itself after its list lands', async () => {
    h.checkpointRows = [point('p-1', 1)];
    act(() => {
      root?.render(<Comments workspaceId="ws-1" entityType="post" entityId="post-1" />);
    });
    await settle();
    expect(commentReads()).toBe(1);
    expect(host?.textContent).toContain('point 1');
  });

  it('a brief never reads checkpoints (unchanged)', async () => {
    act(() => {
      root?.render(<Comments workspaceId="ws-1" entityType="brief" entityId="brief-1" />);
    });
    await settle();
    expect(commentReads()).toBe(0);
  });
});

describe('Comments and the strip with the host read', () => {
  it('neither reads the checkpoints: the list and the chips show the host rows', async () => {
    const rows = [point('p-1', 1), point('p-2', 2, { deleted_at: '2026-01-03T00:00:00.000Z' })];
    const reload = vi.fn(async (): Promise<void> => {});
    await mountShared({ rows, reload });
    expect(commentReads()).toBe(0);
    expect(reload).not.toHaveBeenCalled();
    expect(host?.textContent).toContain('point 1');
    // The strip drops soft-deleted checkpoints, as its own read did.
    expect(chips()).toEqual(['Jump to checkpoint 1']);
  });

  it('holds the skeleton until the host rows land, then paints them', async () => {
    const reload = vi.fn(async (): Promise<void> => {});
    await mountShared({ rows: null, reload });
    expect(host?.textContent).toContain('Loading comments');
    expect(chips()).toEqual([]);
    await mountShared({ rows: [point('p-1', 1)], reload });
    expect(host?.textContent).not.toContain('Loading comments');
    expect(host?.textContent).toContain('point 1');
    expect(chips()).toEqual(['Jump to checkpoint 1']);
    expect(commentReads()).toBe(0);
  });

  it('Retry re-reads the list and asks the host to re-read the checkpoints', async () => {
    h.listOk = false;
    const reload = vi.fn(async (): Promise<void> => {});
    await mountShared({ rows: [], reload });
    const retry = Array.from(host?.querySelectorAll('button') ?? []).find(
      (b) => b.textContent === 'Retry',
    );
    expect(retry).toBeDefined();
    h.listOk = true;
    act(() => retry?.click());
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(commentReads()).toBe(0);
  });
});
