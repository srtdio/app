// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The post page's reads start together: the post, the gallery, the role, the
// members and the comments section (Comments + the checkpoint strip) are all
// asked for on the first render, before any of them answers. The brief is the
// one read that waits, for the post's brief_id. The page never reads the
// buckets itself (the details sheet does, when it opens). The comments section
// mounts once, hidden behind the skeleton, and is the same instance after the
// first paint (no second comments read).

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
vi.mock('@srtdio/briefs', () => ({
  getBrief: () => {
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
    from: () => {
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
    Comments: (props: { focusCommentId?: string | null; belowHeader?: React.ReactNode }) => {
      h.focusIds.push(props.focusCommentId);
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
    CheckpointStrip: () => {
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

import { COMMENTS_SECTION_ID, PostDetailPage } from '@/components/pages/PostDetailPage';

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

async function render(entry = '/posts/p1'): Promise<void> {
  await act(async () => {
    root?.render(
      <MemoryRouter initialEntries={[entry]}>
        <PostDetailPage postId="p1" />
      </MemoryRouter>,
    );
  });
  await settle();
}

function skeleton(): Element | null {
  return document.querySelector('[data-post-skeleton]');
}

/** Resolve every first-paint read (the members flip to loaded with a re-render). */
async function landAll(): Promise<void> {
  h.post!.resolve({ ok: true, data: POST_DETAIL });
  h.gallery!.resolve({ ok: true, data: [] });
  h.role!.resolve('agency');
  await settle();
  h.brief!.resolve({ ok: true, data: { brief: { title: 'Monsoon edit' } } });
  h.membersLoading = false;
  await render();
}

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
  Element.prototype.scrollIntoView = vi.fn();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('post page reads start concurrently', () => {
  it('asks for the post, gallery, role, members, comments and checkpoints before any answers', async () => {
    await render();
    // Nothing has resolved yet: the skeleton is up.
    expect(skeleton()).not.toBeNull();
    for (const read of ['post', 'gallery', 'role', 'members:w1', 'comments', 'checkpoints']) {
      expect(h.calls).toContain(read);
    }
    // The brief needs the post's brief_id, so it is the one read that waits.
    expect(h.calls).not.toContain('brief');
    // The page never reads the buckets (the details sheet does, on open).
    expect(h.calls).not.toContain('buckets');
  });

  it('the brief starts the moment the post lands, without waiting on the other reads', async () => {
    await render();
    h.post!.resolve({ ok: true, data: POST_DETAIL });
    await settle();
    expect(h.calls).toContain('brief');
    // The gallery and role are still in flight: the skeleton holds.
    expect(skeleton()).not.toBeNull();
  });

  it('keeps the comments section hidden behind the skeleton, and never flashes a deep link early', async () => {
    await render('/posts/p1?comment=c1');
    const section = document.getElementById(COMMENTS_SECTION_ID);
    expect(section).not.toBeNull();
    expect(section?.hidden).toBe(true);
    expect(document.querySelector('[data-post-side]')).toBeNull();
    // While hidden, Comments is never handed the focus id.
    expect(h.focusIds.every((id) => id === null)).toBe(true);
  });

  it('paints once every first-paint read lands, with the same comments instance (no second read)', async () => {
    await render('/posts/p1?comment=c1');
    expect(h.commentsMounts).toBe(1);
    expect(h.stripMounts).toBe(1);
    await landAll();
    expect(skeleton()).toBeNull();
    expect(document.querySelector('h1')?.textContent).toContain('Monsoon drop');
    const section = document.getElementById(COMMENTS_SECTION_ID);
    expect(section?.hidden).toBe(false);
    expect(document.querySelector('[data-post-side]')?.contains(section ?? null)).toBe(true);
    // Mounted on the first render and kept across the paint: one comments read.
    expect(h.commentsMounts).toBe(1);
    expect(h.stripMounts).toBe(1);
    expect(h.calls.filter((c) => c === 'comments')).toHaveLength(1);
    // Revealed: the deep-linked comment is handed over now.
    expect(h.focusIds.at(-1)).toBe('c1');
  });
});
