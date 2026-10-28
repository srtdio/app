// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Blink B1: a post opened from the Pipeline painted its page with an empty
// media frame; the picture came 0.4 to 1.3 s later. The Pipeline card had
// already shown that post's small copy (the shared presign cache's thumbnail
// URL), so the post page's media frame now paints that same URL in the very
// commit that first shows the page, and the full image swaps in only after it
// has decoded. No read is added: the cover comes from cache.peekThumbnail,
// synchronously.

const COVER_URL = 'https://files.test/thumb/ver-1';
const FULL_URL = 'https://files.test/full/ver-1';

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
    brief_id: null,
    origin: 'direct',
    updated_at: '2026-10-23T08:00:00.000Z',
    stage_entered_at: '2026-10-23T08:00:00.000Z',
  },
  versions: [],
  annotations: [],
};

const GALLERY = [
  {
    assetAttachmentId: 'aa-1',
    assetVersionId: 'ver-1',
    assetId: 'as-1',
    position: 0,
    filename: 'linen.jpg',
    mimeType: 'image/jpeg',
    kind: 'image',
    width: 1080,
    height: 1350,
    durationMs: null,
    pageCount: null,
    r2Key: null,
    externalUrl: null,
  },
];

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const h = vi.hoisted(() => ({
  post: null as null | { promise: Promise<unknown>; resolve: (v: unknown) => void },
  gallery: null as null | { promise: Promise<unknown>; resolve: (v: unknown) => void },
  role: null as null | { promise: Promise<unknown>; resolve: (v: unknown) => void },
  full: null as null | { promise: Promise<unknown>; resolve: (v: unknown) => void },
  decode: null as null | { promise: Promise<unknown>; resolve: (v: unknown) => void },
  marks: [] as string[],
  network: [] as string[],
}));

vi.mock('@/lib/perf-marks', () => ({
  mark: (name: string) => {
    h.marks.push(name);
  },
  readMarks: () => [],
  clearMarks: () => {},
}));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, VITE_ASSET_READ_URL: 'https://asset-read.test' } };
});
// The app-wide presign cache: the Pipeline card already signed this version's
// small copy, so peekThumbnail answers at once. The full image's URL is a
// pending presign until the test lands it.
vi.mock('@/lib/shared-presign', () => ({
  appPresignCache: () => ({
    peek: () => null,
    peekThumbnail: (versionId: string) =>
      versionId === 'ver-1' ? { url: COVER_URL, expiresAt: Date.now() + 3_600_000 } : null,
    resolve: () => {
      h.network.push('presign:full');
      return h.full!.promise;
    },
    thumbnail: () => {
      h.network.push('presign:thumb');
      return new Promise(() => {});
    },
  }),
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
  getBriefTitle: async () => ({ ok: true, data: null }),
}));
vi.mock('@/lib/assets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/assets')>();
  return {
    ...actual,
    fetchMemberRole: () => h.role!.promise,
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
    getPost: () => h.post!.promise,
    getPostGallery: () => h.gallery!.promise,
  };
});
vi.mock('@/components/comments/Comments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/comments/Comments')>();
  return { ...actual, Comments: () => <div data-comments-stub="">comments</div> };
});
vi.mock('@/components/pages/pcs/CheckpointStrip', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/pages/pcs/CheckpointStrip')>();
  return { ...actual, CheckpointStrip: () => null };
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

import { PostDetailPage } from '@/components/pages/PostDetailPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let observer: MutationObserver | null = null;
/** Each time a media frame (ribbon tile) is added: what it held at that moment. */
let framesSeen: Array<{ cover: string | null; picture: boolean }> = [];

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function frameState(tile: Element): { cover: string | null; picture: boolean } {
  const cover = tile.querySelector('img[data-gallery-cover]')?.getAttribute('src') ?? null;
  const picture = Array.from(tile.querySelectorAll('img')).some(
    (img) => (img.getAttribute('src') ?? '') !== '' && !img.classList.contains('opacity-0'),
  );
  return { cover, picture };
}

function tile(): Element | null {
  return document.querySelector('[data-ribbon-tile]');
}

beforeEach(() => {
  h.post = deferred<unknown>();
  h.gallery = deferred<unknown>();
  h.role = deferred<unknown>();
  h.full = deferred<unknown>();
  h.decode = deferred<unknown>();
  h.marks = [];
  h.network = [];
  framesSeen = [];
  Element.prototype.scrollIntoView = vi.fn();
  Object.defineProperty(HTMLImageElement.prototype, 'decode', {
    configurable: true,
    value: () => h.decode!.promise,
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        if (!(node instanceof Element)) continue;
        const tiles = node.matches('[data-ribbon-tile]')
          ? [node]
          : Array.from(node.querySelectorAll('[data-ribbon-tile]'));
        for (const t of tiles) framesSeen.push(frameState(t));
      }
    }
  });
  observer.observe(host, { childList: true, subtree: true });
  root = createRoot(host);
});

afterEach(() => {
  observer?.disconnect();
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

async function openPost(): Promise<void> {
  await act(async () => {
    root?.render(
      <MemoryRouter initialEntries={['/posts/p1']}>
        <PostDetailPage postId="p1" />
      </MemoryRouter>,
    );
  });
  await settle();
  h.post!.resolve({ ok: true, data: POST_DETAIL });
  h.gallery!.resolve({ ok: true, data: GALLERY });
  h.role!.resolve('agency');
  await settle();
}

describe('post page media frame (blink B1)', () => {
  it('the first paint of the page shows the Pipeline card cover in the media frame', async () => {
    await openPost();
    expect(document.querySelector('[data-post-skeleton]')).toBeNull();
    // Every media frame ever added already held the known cover: never empty.
    expect(framesSeen.length).toBeGreaterThan(0);
    for (const seen of framesSeen) {
      expect(seen.cover).toBe(COVER_URL);
      expect(seen.picture).toBe(true);
    }
    const current = tile();
    expect(current).not.toBeNull();
    expect(current?.querySelector('img[data-gallery-cover]')?.getAttribute('src')).toBe(COVER_URL);
    // The cover came from the cache with no new read: only the full image's
    // presign (which the page always made) is asked for, never a thumbnail.
    expect(h.network).not.toContain('presign:thumb');
  });

  it('swaps to the full image only after it has decoded', async () => {
    await openPost();
    h.full!.resolve({ url: FULL_URL, expiresAt: Date.now() + 3_600_000 });
    await settle();
    const full = () => tile()?.querySelector<HTMLImageElement>('img[data-gallery-full]') ?? null;
    const cover = () => tile()?.querySelector('img[data-gallery-cover]') ?? null;
    expect(full()?.getAttribute('src')).toBe(FULL_URL);
    expect(full()?.classList.contains('opacity-0')).toBe(true);
    expect(cover()).not.toBeNull();

    await act(async () => {
      full()?.dispatchEvent(new Event('load'));
      await Promise.resolve();
    });
    // Loaded but not decoded: the cover still shows.
    expect(cover()).not.toBeNull();
    expect(full()?.classList.contains('opacity-0')).toBe(true);

    await act(async () => {
      h.decode!.resolve(undefined);
      await Promise.resolve();
    });
    await settle();
    expect(cover()).toBeNull();
    expect(full()?.classList.contains('opacity-0')).toBe(false);
    expect(h.marks).toContain('post:media:full-swap');
    // The page paints before the swap, never after it.
    expect(h.marks.indexOf('post:first-paint')).toBeLessThan(
      h.marks.indexOf('post:media:full-swap'),
    );
  });
});
