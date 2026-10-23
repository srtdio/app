// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation, useNavigationType } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Post flow B regressions on the post screen: 25 (one correct first paint),
// 27 (stage and platform once), 28 (visible details row), 29 (open-comments
// chip), 34 (laptop two-column grid shared with the skeleton), 36 (gallery
// load failure), pin / highlight taps never push history, and the title is
// an h1 for every role. Heavy children owned by other work (gallery, comments,
// decision bar, sheets) are stubbed; the page's own wiring is what is tested.

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

type GalleryResult =
  | { ok: true; data: unknown[] }
  | { ok: false; error: { code: string; message: string } };

const h = vi.hoisted(() => ({
  stage: 'review' as string,
  targetDate: '2026-10-28T06:30:00.000Z' as string | null,
  role: 'agency' as string | null,
  roleGate: null as Promise<void> | null,
  galleryGate: null as Promise<void> | null,
  galleryResults: [] as unknown[],
  counts: { resolved: 0, total: 0 },
  desktop: false,
  galleryProps: null as null | { onPinClick?: (commentId: string) => void },
}));

const { getPostGallery } = vi.hoisted(() => ({
  getPostGallery: vi.fn(async (): Promise<unknown> => {
    if (h.galleryGate !== null) await h.galleryGate;
    return h.galleryResults.shift() ?? { ok: true, data: [] };
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
vi.mock('@/lib/use-media-query', () => ({ useMediaQuery: () => h.desktop }));
vi.mock('@/lib/search/jump', () => ({ useSearchJump: () => ({ words: [] }) }));
vi.mock('@/components/pages/pcs/use-post-members', () => ({
  usePostMembers: () => ({
    options: [{ userId: 'u2', displayName: 'Riya Menon', avatarUrl: null }],
    loading: false,
    error: null,
  }),
}));
vi.mock('@/lib/buckets', () => ({
  listBuckets: async () => ({
    ok: true,
    data: [{ id: 'b1', name: 'Monsoon drop', colorHex: '#3b82f6', position: 0 }],
  }),
}));
vi.mock('@srtdio/briefs', () => ({
  getBrief: async () => ({
    ok: true,
    data: { brief: { title: 'Monsoon edit' }, linked_posts_count: 1 },
  }),
}));
vi.mock('@/lib/assets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/assets')>();
  return {
    ...actual,
    fetchMemberRole: async () => {
      if (h.roleGate !== null) await h.roleGate;
      return h.role;
    },
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
          stage: h.stage,
          platform: 'instagram',
          format: 'carousel',
          target_date: h.targetDate,
          owner_user_id: 'u2',
          legacy_author_name: null,
          bucket_id: 'b1',
          brief_id: 'br1',
          origin: 'direct',
          updated_at: '2026-10-23T08:00:00.000Z',
          stage_entered_at: '2026-10-23T08:00:00.000Z',
        },
        versions: [],
        annotations: [],
      },
    }),
    getPostGallery,
  };
});
// Gallery tools and the version button are another change's; the stub keeps
// the props the page passes so a pin tap can be driven.
vi.mock('@/components/pages/pcs/PostGallery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/pages/pcs/PostGallery')>();
  return {
    ...actual,
    PostGallery: (props: { onPinClick?: (commentId: string) => void }) => {
      h.galleryProps = props;
      return <div data-gallery-stub="">gallery</div>;
    },
  };
});
vi.mock('@/components/comments/Comments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/comments/Comments')>();
  return { ...actual, Comments: () => <div data-comments-stub="">comments</div> };
});
vi.mock('@/components/pages/pcs/CheckpointStrip', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/pages/pcs/CheckpointStrip')>();
  const { useEffect } = await import('react');
  return {
    ...actual,
    CheckpointStrip: (props: { onCounts?: (c: { resolved: number; total: number }) => void }) => {
      useEffect(() => {
        props.onCounts?.(h.counts);
      }, [props]);
      return null;
    },
  };
});
vi.mock('@/components/pages/pcs/PostReadyNotice', () => ({ PostReadyNotice: () => null }));
vi.mock('@/components/pages/pcs/PostDecisionBar', () => ({
  PostDecisionBar: () => null,
  DECISION_BAR_SPACE_PX: 0,
}));
vi.mock('@/components/pages/pcs/PostActionSheet', () => ({ PostActionSheet: () => null }));
vi.mock('@/components/pages/pcs/VersionHistorySheet', () => ({ VersionHistorySheet: () => null }));
vi.mock('@/components/pages/assets/AssetUploadSheet', () => ({ AssetUploadSheet: () => null }));
vi.mock('@/components/preview/PlatformPreviewPanel', () => ({
  PlatformPreviewPanel: () => null,
  PreviewChip: () => null,
}));

import {
  COMMENTS_SECTION_ID,
  PostDetailPage,
  openCommentsLabel,
  postPageGrid,
  scrollToCommentsSection,
} from '@/components/pages/PostDetailPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const navLog: { search: string; type: string }[] = [];

function LocationProbe() {
  const location = useLocation();
  const type = useNavigationType();
  navLog.push({ search: location.search, type });
  return null;
}

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
        <LocationProbe />
      </MemoryRouter>,
    );
  });
  await settle();
}

function text(): string {
  return host?.textContent ?? '';
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const scrollIntoView = vi.fn();

beforeEach(() => {
  h.stage = 'review';
  h.targetDate = '2026-10-28T06:30:00.000Z';
  h.role = 'agency';
  h.roleGate = null;
  h.galleryGate = null;
  h.galleryResults = [];
  h.counts = { resolved: 0, total: 0 };
  h.desktop = false;
  h.galleryProps = null;
  navLog.length = 0;
  getPostGallery.mockClear();
  scrollIntoView.mockClear();
  Element.prototype.scrollIntoView = scrollIntoView;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  delete (window as { matchMedia?: unknown }).matchMedia;
});

describe('25. one correct first paint', () => {
  it('keeps the skeleton until the gallery and the role land, then paints once', async () => {
    const gallery = deferred<void>();
    const role = deferred<void>();
    h.galleryGate = gallery.promise;
    h.roleGate = role.promise;
    await render();

    // The post has loaded, but the gallery and the role have not: skeleton only.
    expect(document.querySelector('[data-post-skeleton]')).not.toBeNull();
    expect(document.querySelector('h1')).toBeNull();
    expect(text()).not.toContain('Add images');
    expect(text()).not.toContain('No images on this post yet.');
    expect(document.querySelector('[data-post-details]')).toBeNull();

    await act(async () => gallery.resolve());
    await settle();
    expect(document.querySelector('[data-post-skeleton]')).not.toBeNull();
    expect(document.querySelector('[data-gallery-stub]')).toBeNull();

    await act(async () => role.resolve());
    await settle();
    expect(document.querySelector('[data-post-skeleton]')).toBeNull();
    expect(document.querySelector('[data-gallery-stub]')).not.toBeNull();
    // The owner is a name on the first paint, never blank.
    expect(document.querySelector('[data-detail="owner"]')?.textContent).toContain('Riya Menon');
    // Creator's Edit is there on the first paint (role known).
    expect(document.querySelector('[data-post-details]')?.textContent).toContain('Edit');
  });
});

describe('36. gallery load failure', () => {
  it('shows "Couldn\'t load the pictures." with Retry, never the empty gallery, and Retry reloads', async () => {
    h.galleryResults = [
      { ok: false, error: { code: 'unknown', message: 'boom' } } satisfies GalleryResult,
      { ok: true, data: [] } satisfies GalleryResult,
    ];
    await render();

    expect(text()).toContain("Couldn't load the pictures.");
    expect(document.querySelector('[data-gallery-stub]')).toBeNull();
    expect(text()).not.toContain('No images on this post yet.');
    const retry = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Retry',
    );
    expect(retry).toBeDefined();

    await act(async () => {
      retry?.click();
    });
    await settle();
    expect(getPostGallery).toHaveBeenCalledTimes(2);
    expect(text()).not.toContain("Couldn't load the pictures.");
    expect(document.querySelector('[data-gallery-stub]')).not.toBeNull();
  });
});

describe('27. stage once (top bar), platform and format once (details row)', () => {
  it('has no stage pill and one "Instagram · Carousel"', async () => {
    await render();
    const page = text();
    expect(count(page, 'Instagram · Carousel')).toBe(1);
    expect(document.querySelector('[data-detail="platform"]')?.textContent).toBe(
      'Instagram · Carousel',
    );
    // "In review" appears only in the top bar status line.
    expect(count(page, 'In review')).toBe(1);
    expect(page).not.toContain('Status: ');
  });
});

describe('28. visible details row', () => {
  it('shows owner, "Due 28 Oct", bucket, brief and platform; creators get Edit that opens the sheet', async () => {
    await render();
    const row = document.querySelector<HTMLElement>('[data-post-details]');
    expect(row).not.toBeNull();
    const rowText = row?.textContent ?? '';
    expect(rowText).toContain('Riya Menon');
    expect(rowText).toContain('Due 28 Oct');
    expect(rowText).toContain('Monsoon drop');
    expect(rowText).toContain('Monsoon edit');
    expect(rowText).toContain('Instagram · Carousel');
    expect(rowText).toContain('Edit');
    expect(row?.tagName).toBe('BUTTON');

    await act(async () => {
      row?.click();
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Post details');
  });

  it('omits the due date when there is none; approvers get no Edit', async () => {
    h.targetDate = null;
    h.role = 'client';
    await render();
    const row = document.querySelector<HTMLElement>('[data-post-details]');
    expect(row?.tagName).toBe('DIV');
    expect(document.querySelector('[data-detail="due"]')).toBeNull();
    expect(row?.textContent ?? '').not.toContain('Due');
    expect(row?.textContent ?? '').not.toContain('Edit');
  });
});

describe('29. open-comments chip', () => {
  it('reads "{n} open comments" (singular at 1), hidden at 0', () => {
    expect(openCommentsLabel(2)).toBe('2 open comments');
    expect(openCommentsLabel(1)).toBe('1 open comment');
  });

  it('sits under the title in review and scrolls smoothly to the comments', async () => {
    h.counts = { resolved: 1, total: 3 };
    await render();
    const chip = document.querySelector<HTMLButtonElement>('[data-open-comments-chip]');
    expect(chip?.textContent).toContain('2 open comments');
    const h1 = document.querySelector('h1');
    expect(h1?.compareDocumentPosition(chip!) ?? 0).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    await act(async () => {
      chip?.click();
    });
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    expect(scrollIntoView.mock.contexts[0]).toBe(document.getElementById(COMMENTS_SECTION_ID));
  });

  it('respects reduced motion', () => {
    const node = document.createElement('section');
    node.id = COMMENTS_SECTION_ID;
    document.body.appendChild(node);
    (window as { matchMedia?: unknown }).matchMedia = (q: string) => ({
      matches: q === '(prefers-reduced-motion: reduce)',
    });
    scrollToCommentsSection(document);
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' });
  });

  it('is hidden at 0 and outside review', async () => {
    h.counts = { resolved: 2, total: 2 };
    await render();
    expect(document.querySelector('[data-open-comments-chip]')).toBeNull();
    act(() => root?.unmount());
    root = createRoot(host!);
    h.counts = { resolved: 0, total: 2 };
    h.stage = 'draft';
    await render();
    expect(document.querySelector('[data-open-comments-chip]')).toBeNull();
  });
});

describe('34. laptop two columns, one grid for skeleton and page', () => {
  it('lg: picture left at most 520px, page at most 1120px centred; below lg one column', () => {
    const grid = postPageGrid(false);
    expect(grid.page).toContain('grid-cols-1');
    expect(grid.page).toContain('lg:grid-cols-[minmax(0,520px)_minmax(0,1fr)]');
    expect(grid.page).toContain('max-w-[1120px]');
    expect(grid.page).toContain('mx-auto');
    expect(grid.media).toContain('lg:col-start-1');
    expect(grid.head).toContain('lg:col-start-2');
    expect(grid.body).toContain('lg:col-start-2');
    expect(postPageGrid(true).page).not.toContain('lg:');
  });

  it('the skeleton and the loaded page share the same grid; the right column reads title, details, decision slot, chip, caption, comments', async () => {
    const gallery = deferred<void>();
    h.galleryGate = gallery.promise;
    h.desktop = true;
    h.counts = { resolved: 0, total: 1 };
    await render();
    const skeleton = document.querySelector<HTMLElement>('[data-post-skeleton]');
    const skeletonClass = skeleton?.className;
    expect(skeletonClass).toBe(postPageGrid(false).page);

    await act(async () => gallery.resolve());
    await settle();
    const page = document.querySelector('h1')?.closest('.grid');
    expect(page?.className).toBe(skeletonClass);

    const order = [
      document.querySelector('h1'),
      document.querySelector('[data-post-details]'),
      document.querySelector('[data-open-comments-chip]'),
      document.querySelector('[data-caption-block]'),
      document.getElementById(COMMENTS_SECTION_ID),
    ];
    for (let i = 1; i < order.length; i += 1) {
      expect(order[i]).not.toBeNull();
      expect(order[i - 1]!.compareDocumentPosition(order[i]!)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
    }
  });
});

describe('pin and highlight taps never push history', () => {
  it('the ?comment= strip replaces, and a pin tap leaves the history alone', async () => {
    await render('/posts/p1?comment=c1');
    const last = navLog[navLog.length - 1];
    expect(last?.search).toBe('');
    expect(last?.type).toBe('REPLACE');
    expect(navLog.some((entry) => entry.type === 'PUSH')).toBe(false);

    const before = navLog.length;
    await act(async () => {
      h.galleryProps?.onPinClick?.('c9');
    });
    await settle();
    expect(navLog.slice(before).some((entry) => entry.type === 'PUSH')).toBe(false);
    expect(navLog[navLog.length - 1]?.search).toBe('');
  });

  it('the dead tab code is gone (no ?tab= writes)', () => {
    const src = readFileSync(
      fileURLToPath(new URL('./PostDetailPage.tsx', import.meta.url)),
      'utf8',
    );
    expect(src).not.toContain('PcsTabs');
    expect(src).not.toContain('withPcsTab');
    expect(src).not.toMatch(/setSearchParams\(withPcsTab/);
  });
});

describe('title is an h1 for every role', () => {
  it.each(['agency', 'client'])('%s sees exactly one h1 with the title', async (role) => {
    h.role = role;
    await render();
    const h1s = document.querySelectorAll('h1');
    expect(h1s).toHaveLength(1);
    expect(h1s[0]?.textContent).toContain('Monsoon drop: linen in rain');
    expect(document.querySelector('h2')?.textContent ?? '').not.toContain('Monsoon drop: linen');
  });
});
