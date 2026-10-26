// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MentionCandidate } from '@/lib/workspace-members';

// The post detail page hands its post's stage to Comments, so the comment
// @-mention picker on a draft post offers no client (clients cannot see
// drafts), and on a Review post it offers the client. The Comments stub runs
// the real picker scope (commentMentionCandidates) over the props it is given.

const AGENT = '11111111-1111-4111-8111-111111111111';
const CLIENT = '33333333-3333-4333-8333-333333333333';

const MEMBERS: MentionCandidate[] = [
  { id: AGENT, name: 'Ada Agent', username: 'ada', role: 'agency', avatarUrl: null },
  { id: CLIENT, name: 'Cara Client', username: 'cara', role: 'client', avatarUrl: null },
];

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
  stage: 'review',
  stages: [] as (string | undefined)[],
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
  ensureWorkspaceMembers: () => undefined,
  useWorkspaceMembers: () => ({
    options: [{ userId: 'u2', displayName: 'Riya Menon', avatarUrl: null }],
    loading: false,
    error: null,
    rows: [],
    profiles: new Map(),
    refetch: () => {},
  }),
}));
vi.mock('@/lib/buckets', () => ({
  createBucket: async () => ({ ok: false, error: { code: 'unknown', message: 'x' } }),
  listBuckets: async () => ({ ok: true, data: [] }),
}));
vi.mock('../../../packages/briefs/src/read', () => ({
  getBriefTitle: async () => ({ ok: true, data: 'Monsoon edit' }),
}));
vi.mock('@/lib/assets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/assets')>();
  return {
    ...actual,
    fetchMemberRole: async () => 'agency',
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
    getPost: async () => ({
      ok: true,
      data: { ...POST_DETAIL, post: { ...POST_DETAIL.post, stage: h.stage } },
    }),
    getPostGallery: async () => ({ ok: true, data: [] }),
  };
});
vi.mock('@/components/pages/pcs/PostGallery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/pages/pcs/PostGallery')>();
  return { ...actual, PostGallery: () => <div data-gallery-stub="">gallery</div> };
});
vi.mock('@/components/comments/Comments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/comments/Comments')>();
  const { commentMentionCandidates } = await import('@/components/comments/mention-scope');
  return {
    ...actual,
    Comments: (props: { entityType: 'post' | 'brief'; postStage?: string }) => {
      h.stages.push(props.postStage);
      const offered = commentMentionCandidates(MEMBERS, {
        entityType: props.entityType,
        postStage: props.postStage,
      });
      return (
        <ul data-comments-stub="">
          {offered.map((m) => (
            <li key={m.id} data-offered={m.id} />
          ))}
        </ul>
      );
    },
  };
});
vi.mock('@/components/pages/pcs/CheckpointStrip', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/pages/pcs/CheckpointStrip')>()),
  CheckpointStrip: () => null,
}));
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
vi.mock('@/lib/member-role', () => ({
  readSharedMemberRole: async () => ({ ok: true, role: 'agency' }),
}));

import { PostDetailPage } from '@/components/pages/PostDetailPage';
import { resetPostOpen } from '@/lib/post-prefetch';
import { resetSessionReads } from '@/lib/session-read';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
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

const offered = (): string[] =>
  Array.from(document.querySelectorAll('[data-offered]')).map(
    (el) => el.getAttribute('data-offered') ?? '',
  );

beforeEach(() => {
  h.stage = 'review';
  h.stages = [];
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

describe('post detail comment mentions follow the post stage', () => {
  it('a draft post: Comments gets the draft stage and the picker offers no client', async () => {
    h.stage = 'draft';
    await render();
    expect(document.querySelector('[data-comments-stub]')).not.toBeNull();
    expect(h.stages.at(-1)).toBe('draft');
    expect(offered()).toEqual([AGENT]);
  });

  it('a Review post: Comments gets the review stage and the picker offers the client', async () => {
    h.stage = 'review';
    await render();
    expect(document.querySelector('[data-comments-stub]')).not.toBeNull();
    expect(h.stages.at(-1)).toBe('review');
    expect(offered()).toEqual([AGENT, CLIENT]);
  });
});
