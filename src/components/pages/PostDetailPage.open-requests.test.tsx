// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Opening a post from a card: the press already asked for the post and the
// gallery (src/lib/post-prefetch.ts), so the page's mount joins them and asks
// for nothing twice. The gating requests (what holds the skeleton) are the
// post, the gallery, the role and the members, all in flight before any
// answers; the brief title is the one read that waits, for the post's
// brief_id. Every request is counted, so a second getPost shows.

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const POST_DETAIL = {
  post: {
    id: 'p1',
    workspace_id: 'w1',
    number: 101,
    title: 'Monsoon drop: linen in rain',
    caption: 'Linen that breathes.',
    stage: 'review',
    platform: 'instagram',
    format: 'carousel',
    target_date: null,
    owner_user_id: 'u2',
    legacy_author_name: null,
    bucket_id: null,
    brief_id: 'br1',
    origin: 'direct',
    updated_at: '2026-10-23T08:00:00.000Z',
    stage_entered_at: '2026-10-23T08:00:00.000Z',
  },
  versions: [],
  annotations: [],
};

const h = vi.hoisted(() => ({
  calls: [] as string[],
  post: null as null | { promise: Promise<unknown>; resolve: (v: unknown) => void },
  gallery: null as null | { promise: Promise<unknown>; resolve: (v: unknown) => void },
  role: null as null | { promise: Promise<unknown>; resolve: (v: unknown) => void },
  brief: null as null | { promise: Promise<unknown>; resolve: (v: unknown) => void },
  membersLoading: true,
  commentsMounts: 0,
  stripMounts: 0,
  focusIds: [] as (string | null | undefined)[],
  tables: [] as string[],
  sharedRows: [] as unknown[],
  stripRows: [] as unknown[],
}));

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: () => ({
    workspaceId: 'w1',
    workspaceKey: 'GBL',
    workspaces: [{ id: 'w1', timezone: 'Asia/Kolkata' }],
    workspaceName: 'Kite and Co',
  }),
}));
vi.mock('@/lib/session-context', () => ({
  useSession: () => ({ session: { user: { id: 'u1' } } }),
}));
vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => () => 'trace-1' }));
vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => false,
}));
vi.mock('@/lib/search/jump', () => ({ useSearchJump: () => ({ words: [] }) }));
vi.mock('@/lib/workspace-members', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspace-members')>()),
  // The press warms the same members entry the page's hook reads.
  ensureWorkspaceMembers: () => {
    h.calls.push('press-members');
  },
  useWorkspaceMembers: (workspaceId: string | null) => {
    if (!h.calls.includes(`members:${workspaceId ?? ''}`))
      h.calls.push(`members:${workspaceId ?? ''}`);
    return {
      options: [{ userId: 'u2', displayName: 'Riya Menon', avatarUrl: null }],
      loading: h.membersLoading,
      error: null,
      rows: [],
      profiles: new Map(),
      refetch: () => {},
    };
  },
}));
vi.mock('@/lib/buckets', () => ({
  createBucket: async () => ({ ok: false, error: { code: 'unknown', message: 'x' } }),
  listBuckets: async () => {
    h.calls.push('buckets');
    return { ok: true, data: [] };
  },
}));
// The brief is read for its title alone (one request, no linked-posts count).
vi.mock('../../../packages/briefs/src/read', () => ({
  getBriefTitle: () => {
    h.calls.push('brief');
    return h.brief!.promise;
  },
}));
vi.mock('@/lib/assets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/assets')>();
  return {
    ...actual,
    fetchMemberRole: () => {
      h.calls.push('role');
      return h.role!.promise;
    },
    listAssets: async () => ({ ok: true, data: [] }),
    listRootAssetLabels: async () => ({ ok: true, data: [] }),
  };
});
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: null } }) },
    from: (table: string) => {
      h.tables.push(table);
      const chain = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        not: () => chain,
        is: () => chain,
        order: async () => ({ data: [], error: null }),
      };
      return chain;
    },
  },
}));
vi.mock('@srtdio/posts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@srtdio/posts')>();
  return {
    ...actual,
    getPost: () => {
      h.calls.push('post');
      return h.post!.promise;
    },
    getPostGallery: () => {
      h.calls.push('gallery');
      return h.gallery!.promise;
    },
  };
});
vi.mock('@/components/pages/pcs/PostGallery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/pages/pcs/PostGallery')>();
  return { ...actual, PostGallery: () => <div data-gallery-stub="">gallery</div> };
});
// The comments section: each stub records its mount (once per instance) and
// the focus id it is handed, so a remount or an early deep-link flash shows.
vi.mock('@/components/comments/Comments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/comments/Comments')>();
  const { useEffect } = await import('react');
  return {
    ...actual,
    Comments: (props: {
      focusCommentId?: string | null;
      belowHeader?: React.ReactNode;
      sharedCheckpoints?: { rows: unknown };
    }) => {
      h.focusIds.push(props.focusCommentId);
      h.sharedRows.push(
        props.sharedCheckpoints === undefined ? 'absent' : props.sharedCheckpoints.rows,
      );
      useEffect(() => {
        h.commentsMounts += 1;
        h.calls.push('comments');
      }, []);
      return (
        <div data-comments-stub="">
          {props.belowHeader}
          comments
        </div>
      );
    },
  };
});
vi.mock('@/components/pages/pcs/CheckpointStrip', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/pages/pcs/CheckpointStrip')>();
  const { useEffect } = await import('react');
  return {
    ...actual,
    CheckpointStrip: (props: { checkpoints?: unknown }) => {
      h.stripRows.push(props.checkpoints === undefined ? 'absent' : props.checkpoints);
      useEffect(() => {
        h.stripMounts += 1;
        h.calls.push('checkpoints');
      }, []);
      return null;
    },
  };
});
vi.mock('@/components/pages/pcs/PostDecisionBar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/pages/pcs/PostDecisionBar')>();
  return { ...actual, PostDecisionBar: () => null, DECISION_BAR_SPACE_PX: 0 };
});
vi.mock('@/components/pages/pcs/use-approvers', () => ({ useWorkspaceApprovers: () => [] }));
vi.mock('@/components/pages/pcs/PostActionSheet', () => ({ PostActionSheet: () => null }));
vi.mock('@/components/pages/pcs/PostDetailsSheet', () => ({ PostDetailsSheet: () => null }));
vi.mock('@/components/pages/pcs/VersionHistorySheet', () => ({ VersionHistorySheet: () => null }));
vi.mock('@/components/pages/assets/AssetUploadSheet', () => ({ AssetUploadSheet: () => null }));
vi.mock('@/components/preview/PlatformPreviewPanel', () => ({
  PlatformPreviewPanel: () => null,
  PreviewChip: () => null,
}));

// The press's role and members reads (the page's own go through fetchMemberRole
// and useWorkspaceMembers, which share the same session reads in the app).
vi.mock('@/lib/member-role', () => ({
  readSharedMemberRole: async () => {
    h.calls.push('press-role');
    return { ok: true, role: 'agency' };
  },
}));

import { PostDetailPage } from '@/components/pages/PostDetailPage';
import {
  confirmPostOpen,
  prefetchPostOpen,
  resetPostOpen,
  type PostOpenDeps,
} from '@/lib/post-prefetch';
import { resetSessionReads } from '@/lib/session-read';
import type { Client } from '@srtdio/rpc';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function render(): Promise<void> {
  await act(async () => {
    root?.render(
      <MemoryRouter initialEntries={['/p/gbl-101']}>
        <PostDetailPage postId="p1" />
      </MemoryRouter>,
    );
  });
  await settle();
}

const pressDeps = (): PostOpenDeps => ({
  context: () => ({ userId: 'u1', workspaceId: 'w1' }),
  client: {} as unknown as Client,
  loaders: [],
  now: () => Date.now(),
});

const count = (name: string): number => h.calls.filter((c) => c === name).length;

beforeEach(() => {
  h.calls = [];
  h.post = deferred<unknown>();
  h.gallery = deferred<unknown>();
  h.role = deferred<unknown>();
  h.brief = deferred<unknown>();
  h.membersLoading = true;
  h.commentsMounts = 0;
  h.stripMounts = 0;
  h.focusIds = [];
  h.tables = [];
  h.sharedRows = [];
  h.stripRows = [];
  Element.prototype.scrollIntoView = vi.fn();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  resetPostOpen();
  resetSessionReads();
});

describe('opening a post from a card', () => {
  it('the mount joins the press: one getPost and one gallery read in all', async () => {
    prefetchPostOpen('p1', pressDeps());
    confirmPostOpen('p1', pressDeps());
    expect(count('post')).toBe(1);
    expect(count('gallery')).toBe(1);
    await render();
    expect(count('post')).toBe(1);
    expect(count('gallery')).toBe(1);
  });

  it('holds the skeleton on four gating requests, all in flight before any answers', async () => {
    prefetchPostOpen('p1', pressDeps());
    confirmPostOpen('p1', pressDeps());
    await render();
    expect(document.querySelector('[data-post-skeleton]')).not.toBeNull();
    // Gating: post, gallery, role, members. Nothing else holds the paint.
    expect(count('post')).toBe(1);
    expect(count('gallery')).toBe(1);
    expect(count('role')).toBe(1);
    expect(h.calls).toContain('members:w1');
    // The brief title waits for the post's brief_id, and is one request.
    expect(count('brief')).toBe(0);
    h.post!.resolve({ ok: true, data: POST_DETAIL });
    await settle();
    expect(count('brief')).toBe(1);
    // The page never re-asks for the post while it paints.
    h.gallery!.resolve({ ok: true, data: [] });
    h.role!.resolve('agency');
    h.brief!.resolve({ ok: true, data: 'Monsoon edit' });
    h.membersLoading = false;
    await render();
    expect(document.querySelector('[data-post-skeleton]')).toBeNull();
    expect(count('post')).toBe(1);
    expect(count('gallery')).toBe(1);
  });

  it('a press that never became an open is not joined: the mount reads afresh', async () => {
    prefetchPostOpen('p1', pressDeps());
    await render();
    expect(count('post')).toBe(2);
    expect(count('gallery')).toBe(2);
  });
});
