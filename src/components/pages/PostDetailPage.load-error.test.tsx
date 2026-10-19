// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// FT3: a failed post load shows ui/LoadError ("Couldn't load this post.") with
// a Retry that re-runs the load, and never the raw error text.

const { getPost } = vi.hoisted(() => ({
  getPost: vi.fn(async () => ({
    ok: false as const,
    error: { code: 'unknown', message: 'PGRST RAW SECRET 42P01' },
  })),
}));

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: () => ({
    workspaceId: 'w1',
    workspaceKey: 'GBL',
    workspaces: [],
    workspaceName: 'Zomato',
  }),
}));
vi.mock('@/lib/session-context', () => ({ useSession: () => ({ session: null }) }));
vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => () => 'trace-1' }));
vi.mock('@/lib/use-media-query', () => ({ useMediaQuery: () => false }));
vi.mock('@/lib/search/jump', () => ({ useSearchJump: () => ({ words: [] }) }));
vi.mock('@/components/pages/pcs/use-post-members', () => ({
  usePostMembers: () => ({ options: [], loading: false, error: null }),
}));
vi.mock('@/lib/buckets', () => ({
  listBuckets: async () => ({ ok: true, data: [] }),
}));
vi.mock('@/lib/assets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/assets')>();
  return {
    ...actual,
    fetchMemberRole: async () => null,
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
    getPost,
    getPostGallery: async () => ({ ok: true, data: [] }),
  };
});

import { PostDetailPage } from '@/components/pages/PostDetailPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label,
  );
}

beforeEach(() => {
  getPost.mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('PostDetailPage load error (FT3)', () => {
  it('shows "Couldn\'t load this post." with Retry, never the raw message, and Retry re-runs the load', async () => {
    await act(async () => {
      root?.render(
        <MemoryRouter initialEntries={['/posts/p1']}>
          <PostDetailPage postId="p1" />
        </MemoryRouter>,
      );
    });
    await settle();

    expect(getPost).toHaveBeenCalledTimes(1);
    const text = host?.textContent ?? '';
    expect(text).toContain("Couldn't load this post.");
    expect(text).not.toContain('RAW SECRET');
    expect(text).not.toContain('42P01');
    expect(text).not.toContain('Could not load this post');
    expect(document.querySelector('[role="alert"]')).not.toBeNull();

    const retry = button('Retry');
    expect(retry).toBeDefined();
    await act(async () => {
      retry?.click();
    });
    await settle();
    expect(getPost).toHaveBeenCalledTimes(2);
    expect(host?.textContent ?? '').toContain("Couldn't load this post.");
  });
});
