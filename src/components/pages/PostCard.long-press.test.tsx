// @vitest-environment jsdom
import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipelinePost } from '@srtdio/posts';
import type { PresignCache } from '@/lib/asset-presign';

// Pipeline select mode (no ⋮ on the card): a long-press on touch or a
// right-click on laptop ticks the card and the page's SelectBar ("Selected
// posts") carries the old ⋮ rows. One ticked post: Open, Copy link and Move
// (the move sheet, while the role loads) or the role's moves. Two ticked: the
// per-post rows hide. While selecting, a tap toggles and never opens.

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/post-prefetch', () => ({
  prefetchPostOpen: () => {},
  confirmPostOpen: () => {},
}));

import { PostCard, openPostCard } from '@/components/pages/PostCard';
import { pipelineSelectActions } from '@/components/pages/PipelinePage';
import { SelectBar, useListSelection } from '@/components/ui/SelectBar';
import { LONG_PRESS_MS } from '@/components/ui/useLongPress';
import type { CardViewer } from '@/components/pages/pipeline/card-status';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makePost(id: string, number: number): PipelinePost {
  return {
    id,
    number,
    title: `Post ${id}`,
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
}

const POSTS = [makePost('p1', 7), makePost('p2', 8)];

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

/** The Pipeline's select wiring in miniature: the cards, then the bar while selecting. */
function Harness({ viewer }: { viewer: CardViewer }): ReactElement {
  const navigate = useNavigate();
  const selection = useListSelection();
  const ticked =
    selection.count === 1 ? (POSTS.find((post) => selection.ids.has(post.id)) ?? null) : null;
  const actions = pipelineSelectActions({
    post: ticked,
    count: selection.count,
    viewer,
    onOpen: (post) => selection.leaveThen(() => openPostCard(navigate, post, 'GBL')),
    onCopyLink: () => selection.clear(),
    onMove: () => {},
  });
  return (
    <>
      {POSTS.map((post) => (
        <PostCard
          key={post.id}
          post={post}
          cache={cache}
          presignEnabled={false}
          workspaceKey="GBL"
          viewer={viewer}
          select={selection.selectFor(post.id)}
        />
      ))}
      {selection.active ? (
        <SelectBar
          label="Selected posts"
          count={selection.count}
          onCancel={selection.clear}
          actions={actions}
        />
      ) : null}
    </>
  );
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

const PENDING: CardViewer = { role: null, approverFirstNames: [], pending: true };

function mount(viewer: CardViewer = PENDING): void {
  act(() => {
    root?.render(
      <MemoryRouter initialEntries={['/pipeline']}>
        <Routes>
          <Route path="/pipeline" element={<Harness viewer={viewer} />} />
          <Route path="/p/:ref" element={<Probe />} />
        </Routes>
      </MemoryRouter>,
    );
  });
}

function card(title: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(`button[aria-label="Open post ${title}"]`);
  if (button === null) throw new Error(`no card ${title}`);
  return button;
}

/** A touch hold past LONG_PRESS_MS. */
function hold(target: Element): void {
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

function rightClick(target: Element): void {
  act(() => {
    target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  });
}

function barLabels(): string[] {
  return Array.from(document.querySelectorAll('[data-select-bar-action]')).map(
    (el) => el.getAttribute('aria-label') ?? '',
  );
}

function bar(): Element | null {
  return document.querySelector('[data-select-bar][aria-label="Selected posts"]');
}

describe('Pipeline select mode', () => {
  it('no bar and no ⋮ until a card is held', () => {
    mount();
    expect(bar()).toBeNull();
    expect(document.querySelector('[data-post-card-move]')).toBeNull();
  });

  it('a long-press ticks the card and the bar shows Open, Copy link and Move for one', () => {
    mount();
    hold(card('Post p1'));
    expect(bar()).not.toBeNull();
    expect(document.querySelector('[data-select-bar-count]')?.textContent).toBe('1 selected');
    expect(barLabels()).toEqual(['Open', 'Copy link', 'Move']);
    expect(
      document.querySelector('[data-post-id="p1"]')?.querySelector('[data-list-card-tick="on"]'),
    ).not.toBeNull();
    // The click that trails the hold never opens the post.
    act(() => card('Post p1').click());
    expect(seen).toBeNull();
  });

  it('a right-click ticks the card too; a known role lists its moves', () => {
    mount({ role: 'agency', approverFirstNames: [] });
    rightClick(card('Post p1'));
    expect(barLabels()).toEqual(['Open', 'Copy link', 'Send for review']);
  });

  it('a second ticked card hides Open, Copy link and the per-post moves', () => {
    mount();
    rightClick(card('Post p1'));
    // While selecting, a tap toggles and never opens.
    act(() => card('Post p2').click());
    expect(seen).toBeNull();
    expect(document.querySelector('[data-select-bar-count]')?.textContent).toBe('2 selected');
    expect(barLabels()).not.toContain('Open');
    expect(barLabels()).not.toContain('Copy link');
    expect(barLabels()).not.toContain('Move');
    // Unticking back to one brings them back.
    act(() => card('Post p2').click());
    expect(barLabels()).toEqual(['Open', 'Copy link', 'Move']);
  });

  it('Cancel leaves select mode; the next tap opens the post', () => {
    mount();
    rightClick(card('Post p1'));
    act(() => {
      document.querySelector<HTMLButtonElement>('[data-select-bar-cancel]')?.click();
    });
    expect(bar()).toBeNull();
    act(() => card('Post p1').click());
    expect(seen).toBe('/p/gbl-7');
  });
});
