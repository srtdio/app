import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: 'ws-1', workspaceKey: 'GBL', workspaces: [] }),
}));
vi.mock('@/lib/session-context', () => ({
  useSession: () => ({ session: { user: { id: 'u-1' } } }),
}));

import { PostCover, coverKind, coverOf } from '@/components/chat/PostCover';
import { PostRow, type PostRowContext } from '@/components/chat/PostPicker';
import type { CardFirstMedia, PostCardRow } from '../../../packages/posts/src/reads';

const IMAGE: CardFirstMedia = { assetVersionId: 'v-img', kind: 'image', width: 1080, height: 1080 };
const VIDEO: CardFirstMedia = { assetVersionId: 'v-vid', kind: 'video', width: 1080, height: 1920 };

function cardRow(firstMedia: CardFirstMedia | null): PostCardRow {
  return {
    id: 'p-1',
    number: 301,
    title: 'FICCI Awards 2026',
    format: 'carousel',
    platform: 'linkedin',
    stage: 'review',
    target_date: null,
    stage_entered_at: '2026-10-19T00:00:00Z',
    approved_by: null,
    approved_at: null,
    thumbnailAssetVersionId: firstMedia?.kind === 'image' ? firstMedia.assetVersionId : null,
    firstMedia,
    mediaCount: firstMedia === null ? 0 : 1,
    hasVideo: firstMedia?.kind === 'video',
  } as PostCardRow;
}

describe('coverOf', () => {
  it('is undefined while the post is still being looked up', () => {
    expect(coverOf(undefined)).toBeUndefined();
  });
  it('is null for a hidden post or one with no photo or video', () => {
    expect(coverOf(null)).toBeNull();
    expect(coverOf(cardRow(null))).toBeNull();
  });
  it('is the first photo or video', () => {
    expect(coverOf(cardRow(IMAGE))).toEqual(IMAGE);
    expect(coverOf(cardRow(VIDEO))).toEqual(VIDEO);
  });
});

describe('PostCover', () => {
  it('is a 48px box in every state', () => {
    for (const cover of [undefined, null, IMAGE, VIDEO]) {
      const html = renderToStaticMarkup(<PostCover cover={cover} />);
      expect(html).toContain('h-12 w-12');
      expect(html).toContain(`data-post-cover="${coverKind(cover)}"`);
    }
  });
  it('paints nothing while unknown, so a glyph never swaps for a picture', () => {
    expect(renderToStaticMarkup(<PostCover cover={undefined} />)).not.toContain('<svg');
  });
  it('shows the glyph for a post with no photo or video', () => {
    expect(renderToStaticMarkup(<PostCover cover={null} />)).toContain('<svg');
  });
  it('marks a video with the play badge and a photo without one', () => {
    expect(renderToStaticMarkup(<PostCover cover={VIDEO} />)).toContain('data-post-cover-play');
    expect(renderToStaticMarkup(<PostCover cover={IMAGE} />)).not.toContain('data-post-cover-play');
  });
});

describe('PostRow cover', () => {
  const ctx: PostRowContext = {
    selected: [],
    onToggle: () => undefined,
    workspaceKey: 'GBL',
    timeZone: 'Asia/Kolkata',
  };
  const post = {
    id: 'p-1',
    title: 'FICCI Awards 2026',
    platform: 'linkedin',
    format: 'carousel',
    stage: 'review',
    number: 301,
    caption: null,
    target_date: null,
    created_at: '2026-10-19T00:00:00Z',
  } as Parameters<typeof PostRow>[0]['post'];

  it('shows the post picture from the cover lookup, centred in the row', () => {
    const html = renderToStaticMarkup(
      <ul>
        <PostRow post={post} {...ctx} cover={() => cardRow(VIDEO)} />
      </ul>,
    );
    expect(html).toContain('data-post-cover="video"');
    expect(html).toContain('items-center');
  });

  it('keeps the glyph when no lookup is given', () => {
    const html = renderToStaticMarkup(
      <ul>
        <PostRow post={post} {...ctx} />
      </ul>,
    );
    expect(html).toContain('data-post-cover="none"');
  });
});
