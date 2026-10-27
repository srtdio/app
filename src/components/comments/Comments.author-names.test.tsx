// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommentRow, CommentResult } from '@srtdio/comments';

type ListResult = CommentResult<CommentRow[]>;

const ASHA = '11111111-1111-4111-8111-111111111111';
const GONE = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';

const h = vi.hoisted(() => ({
  pending: [] as Array<(result: ListResult) => void>,
  candidates: [] as Array<{
    id: string;
    name: string;
    username: string | null;
    role: string;
    avatarUrl: string | null;
  }>,
  registry: new Map<string, { name: string; avatar: string | null }>(),
  reads: [] as Array<{ ids: string[]; resolve: (ok: boolean) => void }>,
}));

vi.mock('@srtdio/comments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@srtdio/comments')>();
  return {
    ...actual,
    listComments: vi.fn(
      () =>
        new Promise<ListResult>((resolve) => {
          h.pending.push(resolve);
        }),
    ),
  };
});
vi.mock('@/lib/people-names', () => ({
  FORMER_MEMBER: 'Former member',
  personName: (_ws: string | null, id: string) => h.registry.get(id)?.name,
  personAvatar: (_ws: string | null, id: string) => h.registry.get(id)?.avatar ?? null,
  resolvePeople: vi.fn(
    (_client: unknown, _ws: string | null, ids: Iterable<string>) =>
      new Promise<boolean>((resolve) => {
        h.reads.push({ ids: [...ids], resolve });
      }),
  ),
}));
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: null } }) },
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        in: async () => ({ data: [], error: null }),
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
  useMentionCandidates: () => ({ candidates: h.candidates }),
}));

import { READ_TIMEOUT_MS } from '@/lib/chat-reads';
import { resolvePeople } from '@/lib/people-names';
import { Comments } from '@/components/comments/Comments';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function row(id: string, author: string, body = 'Hello', legacy: string | null = null): CommentRow {
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
    entity_id: 'post-1',
    entity_type: 'post',
    id,
    ledger_batch_id: null,
    ledger_seq: null,
    legacy_author_name: legacy,
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

function render(refreshSignal = 0): void {
  act(() => {
    root?.render(
      <Comments
        workspaceId="ws-1"
        entityType="brief"
        entityId="post-1"
        refreshSignal={refreshSignal}
      />,
    );
  });
}

async function resolveLoad(index: number, rows: CommentRow[]): Promise<void> {
  await act(async () => {
    h.pending[index]?.({ ok: true, data: rows });
    await Promise.resolve();
  });
}

async function answerRead(index: number, ok: boolean): Promise<void> {
  await act(async () => {
    h.reads[index]?.resolve(ok);
    await Promise.resolve();
    await Promise.resolve();
  });
}

function text(): string {
  return host?.textContent ?? '';
}

function readIds(): string[][] {
  return vi.mocked(resolvePeople).mock.calls.map((call) => [...(call[2] as Iterable<string>)]);
}

beforeEach(() => {
  h.pending.length = 0;
  h.candidates = [];
  h.registry.clear();
  h.reads.length = 0;
  vi.mocked(resolvePeople).mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('comment author names paint from held data', () => {
  it('a current member renders name and avatar on the first frame, the names read still pending', async () => {
    h.candidates = [
      { id: ASHA, name: 'Asha Rao', username: 'asha', role: 'creator', avatarUrl: 'https://a/asha.png' },
    ];
    render();
    await resolveLoad(0, [row('c1', ASHA, `Ping @[${GONE}]`)]);
    expect(text()).toContain('Asha Rao');
    expect(host?.querySelector('img[src="https://a/asha.png"]')).not.toBeNull();
    // Only the uncovered mention is asked for; its read has not answered.
    expect(readIds()).toEqual([[GONE]]);
  });

  it('a result dropped by cleanup leaves its ids re-askable and the next run resolves them', async () => {
    render(0);
    await resolveLoad(0, [row('c1', GONE)]);
    expect(readIds()).toEqual([[GONE]]);
    // The rows change while the read is in flight: the first effect is cleaned up.
    render(1);
    await resolveLoad(1, [row('c1', GONE), row('c2', OTHER)]);
    expect(readIds()).toEqual([[GONE], [OTHER]]);
    h.registry.set(GONE, { name: 'Former member', avatar: null });
    await answerRead(0, true);
    // The dropped ids were un-marked and asked again; the registry already knows them.
    expect(readIds()).toEqual([[GONE], [OTHER], [GONE]]);
    await answerRead(2, true);
    expect(text()).toContain('Former member');
  });

  it('registry backfill fills a name with no read answering', async () => {
    h.registry.set(GONE, { name: 'Dev Patel', avatar: 'https://a/dev.png' });
    render();
    await resolveLoad(0, [row('c1', GONE)]);
    expect(text()).toContain('Dev Patel');
    expect(host?.querySelector('img[src="https://a/dev.png"]')).not.toBeNull();
  });

  it('a former member still reads "Former member"', async () => {
    h.candidates = [
      { id: ASHA, name: 'Asha Rao', username: 'asha', role: 'creator', avatarUrl: null },
    ];
    render();
    await resolveLoad(0, [row('c1', GONE)]);
    h.registry.set(GONE, { name: 'Former member', avatar: null });
    await answerRead(0, true);
    expect(text()).toContain('Former member');
  });

  it('legacy_author_name wins over a current member', async () => {
    h.candidates = [
      { id: ASHA, name: 'Asha Rao', username: 'asha', role: 'creator', avatarUrl: 'https://a/asha.png' },
    ];
    render();
    await resolveLoad(0, [row('c1', ASHA, 'Hello', 'Old Import Name')]);
    expect(text()).toContain('Old Import Name');
    expect(text()).not.toContain('Asha Rao');
    expect(host?.querySelector('img[src="https://a/asha.png"]')).toBeNull();
  });

  it('a failed read retries once after READ_TIMEOUT_MS, never twice', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    render();
    await resolveLoad(0, [row('c1', GONE)]);
    await answerRead(0, false);
    expect(readIds()).toHaveLength(1);
    await act(async () => {
      vi.advanceTimersByTime(READ_TIMEOUT_MS);
      await Promise.resolve();
    });
    expect(readIds()).toEqual([[GONE], [GONE]]);
    await answerRead(1, false);
    await act(async () => {
      vi.advanceTimersByTime(READ_TIMEOUT_MS * 2);
      await Promise.resolve();
    });
    expect(readIds()).toHaveLength(2);
  });
});
