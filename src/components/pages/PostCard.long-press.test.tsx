// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipelinePost } from '@srtdio/posts';
import type { PresignCache } from '@/lib/asset-presign';

// A long-press opens the ⋯ menu and arms a guard against its trailing click.
// When the hold ends with no click (iOS), the next press clears that guard, so
// the next tap on the card and the menu's Open row both open the post.

vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => true,
}));
vi.mock('@/lib/post-prefetch', () => ({
  prefetchPostOpen: () => {},
  confirmPostOpen: () => {},
}));

import { PostCard } from '@/components/pages/PostCard';
import { LONG_PRESS_MS } from '@/components/ui/useLongPress';

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

let seen: string | null = null;
function Probe() {
  seen = useLocation().pathname;
  return null;
}

let root: Root | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  seen = null;
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
});

function mount(): HTMLButtonElement {
  act(() => {
    root?.render(
      <MemoryRouter initialEntries={['/pipeline']}>
        <Routes>
          <Route
            path="/pipeline"
            element={
              <PostCard
                post={post}
                cache={cache}
                presignEnabled={false}
                workspaceKey="GBL"
                onMove={() => {}}
              />
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

/** A touch hold past LONG_PRESS_MS, released with no click. */
function holdWithNoClick(target: Element): void {
  act(() => {
    target.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  });
  act(() => {
    vi.advanceTimersByTime(LONG_PRESS_MS);
  });
  act(() => {
    target.dispatchEvent(new Event('pointerup', { bubbles: true }));
  });
}

function tap(target: Element): void {
  act(() => {
    target.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  });
  act(() => {
    target.dispatchEvent(new Event('pointerup', { bubbles: true }));
  });
  act(() => {
    (target as HTMLElement).click();
  });
}

describe('PostCard after a long-press with no click', () => {
  it('the next tap on the card opens the post', () => {
    const button = mount();
    holdWithNoClick(button);
    expect(seen).toBeNull();
    tap(button);
    expect(seen).toBe('/p/gbl-7');
  });

  it("the menu's Open row opens the post", () => {
    const button = mount();
    holdWithNoClick(button);
    const openRow = Array.from(document.querySelectorAll('[role="menuitem"]')).find(
      (el) => el.textContent?.trim() === 'Open',
    );
    if (openRow === undefined) throw new Error('no Open row in the menu');
    tap(openRow);
    expect(seen).toBe('/p/gbl-7');
  });

  it('the click that trails a long-press is still swallowed', () => {
    const button = mount();
    holdWithNoClick(button);
    act(() => {
      button.click();
    });
    expect(seen).toBeNull();
  });
});
