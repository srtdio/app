// @vitest-environment jsdom
// The chat post card's media in a live DOM: the box is the workspace
// platform's one frame whatever the first photo or video is (A2, fixed card
// geometry), a video-only Reel shows its stored thumbnail or, with none, the
// video itself at its first frame (A1), and a media-optional format with no
// media shows its text inside the box (A3).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: { auth: { getSession: vi.fn() } } }));
vi.mock('@/lib/env', () => ({ env: { VITE_ASSET_READ_URL: 'https://read.test' } }));

import { MemoryRouter } from 'react-router-dom';
import type { CardFirstMedia, PostCardRow } from '../../../packages/posts/src/reads';
import { PresignCache } from '@/lib/asset-presign';
import { SharedPostCardList, cardFrame, firstFrameSrc } from '@/components/chat/PostCard';
import { indexPostsById, sharedPostViews } from '@/components/chat/post-card';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HOUR = 3_600_000;
const THUMB = 'https://cdn.test/thumb.jpg';
const VIDEO = 'https://cdn.test/reel.mp4?sig=1';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  vi.spyOn(PresignCache.prototype, 'resolve').mockResolvedValue({
    url: VIDEO,
    expiresAt: Date.now() + HOUR,
  });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function cardRow(over: Partial<PostCardRow>): PostCardRow {
  return {
    id: 'p1',
    number: 12,
    title: 'Post p1',
    platform: 'instagram',
    format: 'single_image',
    stage: 'review',
    target_date: null,
    stage_entered_at: '2026-09-20T10:00:00Z',
    approved_by: null,
    approved_at: null,
    thumbnailAssetVersionId: null,
    firstMedia: null,
    mediaCount: 0,
    hasVideo: false,
    ...over,
  };
}

const media = (over: Partial<CardFirstMedia>): CardFirstMedia => ({
  assetVersionId: 'v1',
  kind: 'image',
  width: null,
  height: null,
  ...over,
});

async function show(post: PostCardRow): Promise<void> {
  const views = sharedPostViews([post.id], indexPostsById([post]), new Map());
  await act(async () => {
    root!.render(
      <MemoryRouter>
        <SharedPostCardList views={views} side="agency" timeZone="UTC" />
      </MemoryRouter>,
    );
  });
}

const frameEl = (): HTMLElement | null => document.querySelector('[data-frame-ratio]');
const ratio = (): number => Number(frameEl()?.getAttribute('data-frame-ratio'));

describe('A2: the card box is the platform frame, whatever the first media', () => {
  it('a stored 1:1 photo on an Instagram post sits in the 4:5 box (cropped to fill)', async () => {
    const photo = media({ width: 1080, height: 1080 });
    // The post's own frame still follows its media (the sheet and post page use it).
    expect(cardFrame({ platform: 'instagram', format: 'single_image', firstMedia: photo })).toEqual(
      expect.objectContaining({ ratio: 1, source: 'media' }),
    );
    await show(cardRow({ thumbnailAssetVersionId: 'v1', firstMedia: photo, mediaCount: 1 }));
    expect(ratio()).toBeCloseTo(4 / 5);
  });

  it('a photo with no stored size (older upload): the same 4:5 box', async () => {
    await show(cardRow({ thumbnailAssetVersionId: 'v1', firstMedia: media({}), mediaCount: 1 }));
    expect(ratio()).toBeCloseTo(4 / 5);
  });

  it('a tall stored size: still the 4:5 box', async () => {
    const tall = media({ width: 1080, height: 3000 });
    await show(cardRow({ thumbnailAssetVersionId: 'v1', firstMedia: tall, mediaCount: 1 }));
    expect(ratio()).toBeCloseTo(4 / 5);
  });
});

describe('A1: a video-only Reel shows media in the platform box', () => {
  const reel = cardRow({
    format: 'reel',
    firstMedia: media({ kind: 'video', width: 1080, height: 1920 }),
    mediaCount: 1,
    hasVideo: true,
  });

  it('with a stored thumbnail: the rendition through the asset-read thumbnail route', async () => {
    const thumbnail = vi
      .spyOn(PresignCache.prototype, 'thumbnail')
      .mockResolvedValue({ url: THUMB, expiresAt: Date.now() + HOUR });
    await show(reel);
    expect(ratio()).toBeCloseTo(4 / 5);
    expect(thumbnail).toHaveBeenCalledWith('v1');
    const img = document.querySelector<HTMLImageElement>('[data-card-video-thumb]');
    expect(img?.getAttribute('src')).toBe(THUMB);
    expect(document.querySelector('[data-card-video]')).toBeNull();
    expect(document.querySelector('[data-card-play]')).not.toBeNull();
    // No KEY-N code anywhere on the card: not on the media, not by the title.
    expect(document.querySelector('[data-card-ref]')).toBeNull();
    expect(document.querySelector('[data-card-pill-ref]')).toBeNull();
    expect(document.body.textContent ?? '').not.toMatch(/\b[A-Z]{2,}-\d+\b/);
  });

  it('with no thumbnail (older video): the video itself at its first frame', async () => {
    vi.spyOn(PresignCache.prototype, 'thumbnail').mockResolvedValue(null);
    await show(reel);
    expect(ratio()).toBeCloseTo(4 / 5);
    expect(document.querySelector('[data-card-video-thumb]')).toBeNull();
    const video = document.querySelector<HTMLVideoElement>('[data-card-video]');
    expect(video).not.toBeNull();
    expect(video!.getAttribute('src')).toBe(firstFrameSrc(VIDEO));
    expect(video!.getAttribute('preload')).toBe('metadata');
    expect(video!.muted).toBe(true);
    expect(video!.hasAttribute('playsinline')).toBe(true);
    // The play icon matches FileTile's overlay and never takes the card's tap.
    const play = document.querySelector<HTMLElement>('[data-card-play]');
    expect(play?.className).toContain('pointer-events-none');
    expect(play?.innerHTML).toContain('bg-overlay text-overlay-fg');
  });

  it('a mixed post: the first media item in display order decides', async () => {
    vi.spyOn(PresignCache.prototype, 'thumbnail').mockResolvedValue(null);
    await show(
      cardRow({
        format: 'carousel',
        thumbnailAssetVersionId: 'v-photo',
        firstMedia: media({ assetVersionId: 'v-video', kind: 'video' }),
        mediaCount: 2,
        hasVideo: true,
      }),
    );
    expect(document.querySelector('[data-card-video]')).not.toBeNull();
  });

  it('firstFrameSrc adds the t=0.1 fragment to a presigned URL', () => {
    const src = new URL(firstFrameSrc(VIDEO));
    expect(src.hash.slice(1)).toBe('t=0.1');
    expect(src.search).toBe('?sig=1');
  });
});

describe('A3: a media-optional format with no media shows its text in the box', () => {
  it('an X thread with no media: its title inside the X box (no KEY-N code)', async () => {
    await show(cardRow({ platform: 'x', format: 'thread' }));
    expect(ratio()).toBeCloseTo(16 / 9);
    expect(document.querySelector('[data-card-text]')?.textContent).toBe('Post p1');
    expect(document.querySelector('[data-card-media] img')).toBeNull();
    expect(document.querySelector('[data-card-ref]')).toBeNull();
    expect(document.querySelector('[data-card-title]')).not.toBeNull();
    expect(document.body.textContent ?? '').not.toMatch(/\b[A-Z]{2,}-\d+\b/);
  });

  it('an X thread with a photo: framed', async () => {
    await show(
      cardRow({
        platform: 'x',
        format: 'thread',
        thumbnailAssetVersionId: 'v1',
        firstMedia: media({ width: 1200, height: 675 }),
        mediaCount: 1,
      }),
    );
    expect(ratio()).toBeCloseTo(16 / 9);
  });
});
