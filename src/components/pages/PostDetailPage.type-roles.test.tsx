// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Type roles on the post screen (design rules, 24 Oct 2026): page title
// 3xl/600 tracking-tight (28/34, no leading override), the header status line
// is a screen header (lg/600), the caption block's author row is a card title
// (base/500), the owner / due line is meta (sm, fg-3) and the caption is body.
// Mocks mirror PostDetailPage.flowb3.test.tsx; heavy children are stubbed.

const h = vi.hoisted(() => ({ role: 'client' as string | null }));

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
vi.mock('@/lib/use-media-query', () => ({
  LAPTOP_QUERY: '(min-width: 768px)',
  useMediaQuery: (query: string) => query !== '(min-width: 1024px)',
}));
vi.mock('@/lib/search/jump', () => ({ useSearchJump: () => ({ words: [] }) }));
vi.mock('@/components/pages/pcs/use-post-members', () => ({
  usePostMembers: () => ({
    options: [{ userId: 'u2', displayName: 'Riya Menon', avatarUrl: null }],
    loading: false,
    error: null,
  }),
}));
vi.mock('@/lib/buckets', () => ({
  listBuckets: async () => ({ ok: true, data: [] }),
}));
vi.mock('@/lib/assets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/assets')>();
  return {
    ...actual,
    fetchMemberRole: async () => h.role,
    listAssets: async () => ({ ok: true, data: [] }),
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
      data: {
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
          brief_id: null,
          origin: 'direct',
          approved_by: null,
          approved_at: null,
          updated_at: '2026-10-23T08:00:00.000Z',
          stage_entered_at: '2026-10-23T08:00:00.000Z',
        },
        versions: [],
        annotations: [],
      },
    }),
    getPostGallery: async () => ({ ok: true, data: [] }),
    postCaptionUpdate: vi.fn(),
    stageTransition: vi.fn(),
  };
});
vi.mock('@/components/pages/pcs/use-approvers', () => ({
  useWorkspaceApprovers: () => [],
}));
vi.mock('@srtdio/rpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@srtdio/rpc')>();
  return { ...actual, stageTransition: vi.fn() };
});
vi.mock('@/components/pages/pcs/PostGallery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/pages/pcs/PostGallery')>();
  return { ...actual, PostGallery: () => <div data-gallery-stub="">gallery</div> };
});
vi.mock('@/components/comments/Comments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/comments/Comments')>();
  return { ...actual, Comments: () => <div data-comments-stub="" /> };
});
vi.mock('@/components/pages/pcs/CheckpointStrip', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/pages/pcs/CheckpointStrip')>();
  return { ...actual, CheckpointStrip: () => null };
});
vi.mock('@/components/pages/pcs/PostActionSheet', () => ({ PostActionSheet: () => null }));
vi.mock('@/components/pages/pcs/PostDetailsSheet', () => ({ PostDetailsSheet: () => null }));
vi.mock('@/components/pages/pcs/VersionHistorySheet', () => ({ VersionHistorySheet: () => null }));
vi.mock('@/components/pages/assets/AssetUploadSheet', () => ({ AssetUploadSheet: () => null }));
vi.mock('@/components/preview/PlatformPreviewPanel', () => ({
  PlatformPreviewPanel: () => null,
  PreviewChip: () => null,
}));

import { PostDetailPage } from '@/components/pages/PostDetailPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function render(): Promise<void> {
  await act(async () => {
    root?.render(
      <MemoryRouter initialEntries={['/posts/p1']}>
        <PostDetailPage postId="p1" />
      </MemoryRouter>,
    );
  });
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/** The deepest element whose trimmed text is exactly `text`. */
function byText(text: string, scope: Element = document.body): HTMLElement {
  const matches = [...scope.querySelectorAll<HTMLElement>('*')].filter(
    (el) => el.textContent?.trim() === text,
  );
  const el = matches[matches.length - 1];
  if (el === undefined) throw new Error(`no element with text "${text}"`);
  return el;
}

function classes(el: Element | null): string[] {
  return (el?.getAttribute('class') ?? '').split(/\s+/);
}

beforeEach(() => {
  h.role = 'client';
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

describe('PostDetailPage type roles', () => {
  it('page title: text-3xl font-semibold tracking-tight, no line-height override', async () => {
    await render();
    const h1 = byText('Monsoon drop: linen in rain').closest('h1');
    expect(h1).not.toBeNull();
    const cls = classes(h1);
    expect(cls).toEqual(expect.arrayContaining(['text-3xl', 'font-semibold', 'tracking-tight']));
    expect(cls.some((c) => c.startsWith('leading-'))).toBe(false);
  });

  it('the header status line is a screen header: text-lg font-semibold', async () => {
    await render();
    const status = document.querySelector('.h-14 span.text-lg');
    expect(status).not.toBeNull();
    expect(classes(status)).toContain('font-semibold');
  });

  it('caption block author row is a card title: text-base font-medium', async () => {
    await render();
    const block = document.querySelector('[data-caption-block]');
    expect(block).not.toBeNull();
    const cls = classes(byText('Kite and Co', block!));
    expect(cls).toEqual(expect.arrayContaining(['text-base', 'font-medium']));
    expect(cls).not.toContain('font-semibold');
  });

  it('owner / due line is meta: text-sm text-fg-3', async () => {
    await render();
    const meta = byText('Riya Menon').closest('[data-post-details]');
    expect(meta).not.toBeNull();
    expect(classes(meta)).toEqual(expect.arrayContaining(['text-sm', 'text-fg-3']));
  });

  it('caption is body: text-base text-fg', async () => {
    await render();
    const caption = byText('Linen that breathes.').closest('.text-base');
    expect(caption).not.toBeNull();
    expect(classes(caption)).toContain('text-fg');
  });

  it('renders no off-scale type classes', async () => {
    await render();
    expect(document.body.innerHTML).not.toMatch(
      /text-legacy-|text-\[\d|leading-\[\d|font-bold|font-\[/,
    );
  });
});
