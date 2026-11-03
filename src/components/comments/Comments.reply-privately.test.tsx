// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommentRow, CommentResult } from '@srtdio/comments';

// Reply privately on post and brief comments: shown only on someone else's
// comment with a known current author (never mine, a legacy author or a former
// member), between Reply and Copy; a tap opens the person card's inline
// message for the author with the comment as its source (no navigation). The
// author's photo and name carry the same source.

type ListResult = CommentResult<CommentRow[]>;

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const GONE = '33333333-3333-4333-8333-333333333333';
const LEGACY = '44444444-4444-4444-8444-444444444444';

const h = vi.hoisted(() => ({
  rows: [] as CommentRow[],
}));

vi.mock('@srtdio/comments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@srtdio/comments')>();
  return {
    ...actual,
    listComments: vi.fn(async (): Promise<ListResult> => ({ ok: true, data: h.rows })),
  };
});
vi.mock('@/components/ui/toast', () => ({
  useOptionalToast: () => ({ show: () => 'toast-1', dismiss: () => undefined }),
}));
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { user: { id: ME } } } }) },
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
  return {
    ...actual,
    resolvePeople: async () => true,
    personName: (_ws: string, id: string) => (id === GONE ? actual.FORMER_MEMBER : undefined),
    personAvatar: () => null,
  };
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
      { id: ME, name: 'Mia Me', username: 'mia', role: 'agency', avatarUrl: null },
      { id: OTHER, name: 'Omar Other', username: 'omar', role: 'agency', avatarUrl: null },
    ],
  }),
}));

import { Comments } from '@/components/comments/Comments';
import { REPLY_PRIVATELY } from '@/lib/chat/private-reply';
import { closePersonCard, personCardSnapshot } from '@/lib/person-card';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function row(
  id: string,
  author: string,
  body: string,
  extra: Partial<CommentRow> = {},
): CommentRow {
  return {
    accepted_at: null,
    accepted_by: null,
    asked_at: null,
    asked_by: null,
    attachment_asset_ids: null,
    author_user_id: author,
    body,
    closed_at: null,
    closed_by: null,
    created_at: '2026-01-01T00:00:00.000Z',
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
    ...extra,
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

async function mount(routed = true): Promise<void> {
  const comments = (
    <Comments workspaceId="ws-1" entityType="brief" entityId="brief-1" whereLabel="Spring launch" />
  );
  act(() => {
    root?.render(routed ? <MemoryRouter>{comments}</MemoryRouter> : comments);
  });
  await settle();
}

function rowEl(id: string): HTMLElement | null {
  return host?.querySelector(`#comment-${id}`) ?? null;
}

function actionWords(id: string): string[] {
  const actions = rowEl(id)?.querySelector('[data-comment-actions]');
  return Array.from(actions?.querySelectorAll('button') ?? []).map(
    (b) => b.textContent?.trim() ?? '',
  );
}

function replyPrivately(id: string): HTMLButtonElement | null {
  return rowEl(id)?.querySelector<HTMLButtonElement>('[data-row-action="reply-privately"]') ?? null;
}

beforeEach(() => {
  h.rows = [
    row('c-other', OTHER, `Can @[${ME}] check the hook?`, {
      created_at: '2026-01-04T00:00:00.000Z',
    }),
    row('c-mine', ME, 'mine', { created_at: '2026-01-03T00:00:00.000Z' }),
    row('c-gone', GONE, 'from someone who left', { created_at: '2026-01-02T00:00:00.000Z' }),
    row('c-legacy', LEGACY, 'imported', { legacy_author_name: 'Old Import' }),
  ];
  closePersonCard();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  closePersonCard();
  root = null;
  document.body.innerHTML = '';
});

describe('Reply privately on comments', () => {
  it("shows on another member's comment, between Reply and Copy", async () => {
    await mount();
    expect(actionWords('c-other')).toEqual(['Resolve', 'Reply', REPLY_PRIVATELY, 'Copy']);
    const button = replyPrivately('c-other');
    expect(button?.className).toContain('h-11');
    expect(button?.className).toContain('min-w-[44px]');
  });

  it('is hidden on my own, a former member and a legacy author', async () => {
    await mount();
    for (const id of ['c-mine', 'c-gone', 'c-legacy']) {
      expect(replyPrivately(id)).toBeNull();
      expect(actionWords(id)).not.toContain(REPLY_PRIVATELY);
    }
  });

  it('draws nothing outside a router (nowhere to open)', async () => {
    await mount(false);
    expect(replyPrivately('c-other')).toBeNull();
  });

  const QUOTE = {
    kind: 'comment',
    sourceId: 'c-other',
    authorUserId: OTHER,
    authorName: 'Omar Other',
    excerpt: 'Can @mia check the hook?',
    whereLabel: 'Spring launch',
    link: { kind: 'comment', entityType: 'brief', entityId: 'brief-1', commentId: 'c-other' },
  };

  it('a tap opens the inline message card with the comment as its source', async () => {
    await mount();
    const button = replyPrivately('c-other');
    act(() => button?.click());
    const request = personCardSnapshot();
    expect(request?.userId).toBe(OTHER);
    expect(request?.view).toBe('card');
    expect(request?.trigger).toBe(button);
    expect(request?.source).toEqual(QUOTE);
  });

  it("the author's name opens the card carrying the same source", async () => {
    await mount();
    const trigger = rowEl('c-other')?.querySelector<HTMLElement>(
      `[data-person-trigger="${OTHER}"]`,
    );
    expect(trigger).not.toBeNull();
    act(() => trigger?.click());
    expect(personCardSnapshot()?.userId).toBe(OTHER);
    expect(personCardSnapshot()?.source).toEqual(QUOTE);
  });

  it('my own comment and a former member open the card with no source', async () => {
    await mount();
    for (const [id, who] of [
      ['c-mine', ME],
      ['c-gone', GONE],
    ] as const) {
      closePersonCard();
      const trigger = rowEl(id)?.querySelector<HTMLElement>(`[data-person-trigger="${who}"]`);
      if (trigger === null || trigger === undefined) continue;
      act(() => trigger.click());
      expect(personCardSnapshot()?.source ?? null).toBeNull();
    }
  });
});
