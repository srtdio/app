import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: 'ws-1', workspaceKey: 'GBL', workspaces: [] }),
}));
vi.mock('@/lib/session-context', () => ({
  useSession: () => ({ session: { user: { id: 'u-1' } } }),
}));

import { PostCover, coverKind } from '@/components/chat/PostCover';
import { PostRow, type PostRowContext } from '@/components/chat/PostPicker';
import type { CardFirstMedia } from '../../../packages/posts/src/reads';

const IMAGE: CardFirstMedia = { assetVersionId: 'v-img', kind: 'image', width: 1080, height: 1080 };
const VIDEO: CardFirstMedia = { assetVersionId: 'v-vid', kind: 'video', width: 1080, height: 1920 };

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
        <PostRow post={post} {...ctx} cover={() => VIDEO} />
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

describe('picker warm-up helpers', () => {
  it('keys the warm list on everything the default list depends on', async () => {
    const { sectionsMemoKey } = await import('@/components/chat/PostPicker');
    const base = { workspaceId: 'ws-1', mode: 'posts' as const, allowDrafts: false, role: 'admin' };
    expect(sectionsMemoKey(base)).not.toBe(sectionsMemoKey({ ...base, allowDrafts: true }));
    expect(sectionsMemoKey(base)).not.toBe(sectionsMemoKey({ ...base, role: 'client' }));
    expect(sectionsMemoKey(base)).not.toBe(sectionsMemoKey({ ...base, workspaceId: 'ws-2' }));
  });

  it('warms the first rows in display order across sections', async () => {
    const { leadingPostIds } = await import('@/components/chat/PostPicker');
    const row = (id: string) => ({ id }) as never;
    const data = {
      sections: [
        { key: 'review', label: 'Waiting', rows: [row('a'), row('b')] },
        { key: 'approved', label: 'Approved', rows: [row('c')] },
      ],
      olderApprovedCount: 0,
    } as never;
    expect(leadingPostIds(data, 2)).toEqual(['a', 'b']);
    expect(leadingPostIds(data, 8)).toEqual(['a', 'b', 'c']);
  });
});
