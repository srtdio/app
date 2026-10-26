// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipelinePost } from '@srtdio/posts';
import type { PresignCache } from '@/lib/asset-presign';

// A press on the card's Open post button starts the post open (chunk and
// first reads); the click that follows confirms it and opens the pretty link
// with the post's id in router state, so /p/:ref needs no lookup.

const h = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => true,
}));
vi.mock('@/lib/post-prefetch', () => ({
  prefetchPostOpen: (id: string) => h.calls.push(`press:${id}`),
  confirmPostOpen: (id: string) => h.calls.push(`confirm:${id}`),
}));

import { PostCard } from '@/components/pages/PostCard';
import { knownRefId } from '@/lib/entityRef';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const post = {
  id: 'p1',
  number: 7,
  title: 'Post title',
  platform: 'instagram',
  format: 'text',
  caption: null,
  target_date: null,
  stage: 'draft',
  origin: 'manual',
  legacy_author_name: null,
  bucket_id: null,
  brief_id: null,
  owner_user_id: 'u1',
  created_by: 'u1',
  workspace_id: 'w1',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  stage_entered_at: '2026-01-01T00:00:00Z',
  approved_by: null,
  approved_on_behalf_of: null,
  approved_at: null,
  deleted_at: null,
  row_version: 1,
  thumbnailAssetVersionId: null,
} as unknown as PipelinePost;

const cache = {
  peek: () => null,
  resolve: async () => null,
  peekThumbnail: () => null,
  thumbnail: async () => null,
} as unknown as PresignCache;

let seen: { pathname: string; state: unknown } | null = null;
function Probe() {
  const location = useLocation();
  seen = { pathname: location.pathname, state: location.state };
  return null;
}

let root: Root | null = null;

beforeEach(() => {
  h.calls = [];
  seen = null;
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

async function mount(): Promise<HTMLButtonElement> {
  await act(async () => {
    root?.render(
      <MemoryRouter initialEntries={['/pipeline']}>
        <Routes>
          <Route
            path="/pipeline"
            element={
              <PostCard post={post} cache={cache} presignEnabled={false} workspaceKey="GBL" />
            }
          />
          <Route path="/p/:ref" element={<Probe />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  const button = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Open post Post title"]',
  );
  if (button === null) throw new Error('no Open post button');
  return button;
}

describe('PostCard press prefetch', () => {
  it('a press starts the open before the click lands', async () => {
    const button = await mount();
    await act(async () => {
      button.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(h.calls).toEqual(['press:p1']);
  });

  it('the click confirms the press, then opens /p/key-n carrying the id for that ref', async () => {
    const button = await mount();
    await act(async () => {
      button.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    await act(async () => {
      button.click();
    });
    expect(h.calls).toEqual(['press:p1', 'confirm:p1']);
    expect(seen?.pathname).toBe('/p/gbl-7');
    expect(knownRefId(seen?.state, 'post', 'gbl-7')).toBe('p1');
  });
});
