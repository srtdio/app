import { afterEach, describe, expect, it, vi } from 'vitest';

// The layout under test: touch (phone) or laptop.
const laptop = vi.hoisted(() => ({ on: false }));
vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => laptop.on,
}));

import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { CardFirstMedia, PostCardRow } from '../../../packages/posts/src/reads';
import { PostCardSkeleton, SharedPostCardList } from '@/components/chat/PostCard';
import { indexPostsById, sharedPostViews } from '@/components/chat/post-card';
import {
  cardMediaHeight,
  cardTitleHeight,
  chatCardFrame,
  postCardHeight,
} from '@/components/chat/post-card-geometry';

// One fixed shape (28 Oct): the loading box and the loaded card have the same
// outer height on the first frame, whatever the post holds, so a card filling
// in never moves a row. Every part of the box is a fixed size: the media box
// (the workspace platform's frame), the two-line title area, the meta row and
// the 44px footer.

afterEach(() => {
  laptop.on = false;
});

const COVER: CardFirstMedia = { assetVersionId: 'v1', kind: 'image', width: 1080, height: 1080 };

function row(over: Partial<PostCardRow>): PostCardRow {
  return {
    id: 'p1',
    number: 12,
    title: 'Launch teaser',
    platform: 'instagram',
    format: 'single_image',
    stage: 'review',
    target_date: '2026-11-02',
    stage_entered_at: '2026-09-20T10:00:00Z',
    approved_by: null,
    approved_at: null,
    caption: null,
    thumbnailAssetVersionId: null,
    firstMedia: null,
    mediaCount: 0,
    hasVideo: false,
    ...over,
  };
}

const LONG_TITLE =
  'Festive launch week carousel: the hero shot, the price cards for all twelve products, ' +
  'the store map and the booking link, with the brand sign-off on the final frame';

/** The four card cases the decision names, per platform. */
function cases(platform: string): Array<[string, PostCardRow]> {
  // TikTok offers video only; every other platform here a single image.
  const media = platform === 'tiktok' ? 'video' : 'single_image';
  // Instagram and TikTok offer no text format: their bare box (no media) instead.
  const text = platform === 'instagram' || platform === 'tiktok' ? media : 'text';
  return [
    [
      'cover + 1-line title',
      row({
        platform,
        format: media,
        thumbnailAssetVersionId: 'v1',
        firstMedia: COVER,
        mediaCount: 1,
      }),
    ],
    [
      'cover + 3-line title',
      row({
        platform,
        format: media,
        title: LONG_TITLE,
        thumbnailAssetVersionId: 'v1',
        firstMedia: COVER,
        mediaCount: 1,
      }),
    ],
    [
      'text-only post',
      text === 'text'
        ? row({ platform, format: 'text', caption: `${LONG_TITLE}\n\n${LONG_TITLE}` })
        : row({ platform, format: text }),
    ],
    ['missing cover', row({ platform, format: media })],
  ];
}

/** The outer height (px) of a markup's first element carrying a height style. */
function outerHeight(html: string): number {
  const match = /style="height:([\d.]+)px/.exec(html);
  if (match === null) throw new Error(`no fixed height in ${html.slice(0, 200)}`);
  return Number(match[1]);
}

function loaded(post: PostCardRow, platform: string, sideKnown = true): string {
  const views = sharedPostViews([post.id], indexPostsById([post]), new Map());
  return renderToStaticMarkup(
    <MemoryRouter>
      <SharedPostCardList
        views={views}
        side="agency"
        sideKnown={sideKnown}
        timeZone="UTC"
        workspaceZone="UTC"
        platform={platform}
      />
    </MemoryRouter>,
  );
}

function skeleton(platform: string): string {
  return renderToStaticMarkup(<PostCardSkeleton platform={platform} />);
}

describe('chat post card: one fixed shape, loaded or not', () => {
  for (const layout of ['touch', 'laptop'] as const) {
    for (const platform of ['instagram', 'linkedin', 'x', 'threads', 'tiktok']) {
      it(`${layout}, ${platform}: the loading box and every loaded case match`, () => {
        laptop.on = layout === 'laptop';
        const expected = postCardHeight(chatCardFrame(platform), layout);
        expect(outerHeight(skeleton(platform))).toBe(expected);
        for (const [name, post] of cases(platform)) {
          const html = loaded(post, platform);
          expect(outerHeight(html), name).toBe(expected);
          // The title area is always two lines tall, whatever the title's length.
          expect(html, name).toContain(`height:${cardTitleHeight(layout)}px`);
          expect(html, name).toContain('line-clamp-2');
          // The media box is the platform frame's height, cover or not.
          expect(html, name).toMatch(
            new RegExp(
              `data-card-media=""[^>]*height:${cardMediaHeight(chatCardFrame(platform))}px`,
            ),
          );
        }
      });
    }
  }

  it('the side not known yet keeps the 44px footer row (no wording), same height', () => {
    const post = cases('instagram')[0]![1];
    const known = loaded(post, 'instagram', true);
    const unknown = loaded(post, 'instagram', false);
    expect(outerHeight(unknown)).toBe(outerHeight(known));
    expect(unknown).not.toContain('data-card-footer');
    expect(unknown).toContain('h-[44px]');
  });

  it('a not-visible card and a couldn’t-load card take the same box', () => {
    const expected = outerHeight(skeleton('instagram'));
    const hidden = renderToStaticMarkup(
      <MemoryRouter>
        <SharedPostCardList
          views={sharedPostViews(['gone'], new Map(), new Map())}
          side="agency"
          platform="instagram"
        />
      </MemoryRouter>,
    );
    expect(outerHeight(hidden)).toBe(expected);
    const failed = renderToStaticMarkup(
      <MemoryRouter>
        <SharedPostCardList
          views={sharedPostViews(['p1'], new Map(), new Map())}
          failed={['p1']}
          side="agency"
          platform="instagram"
        />
      </MemoryRouter>,
    );
    expect(failed).toContain('data-card-failed');
    expect(outerHeight(failed)).toBe(expected);
  });

  it('the loading box has a neutral fill and no pulse', () => {
    const html = skeleton('instagram');
    expect(html).toContain('bg-panel-2');
    expect(html).not.toContain('animate-pulse');
  });

  it('the fixed parts add up: border, media box, padded two-line body, meta row, footer', () => {
    const frame = chatCardFrame('instagram');
    // 4:5 at the 238px inner width is 297.5, whole px 298.
    expect(cardMediaHeight(frame)).toBe(298);
    expect(postCardHeight(frame, 'touch')).toBe(2 + 298 + 20 + 40 + 6 + 20 + 44);
    expect(postCardHeight(frame, 'laptop')).toBe(2 + 298 + 20 + 38 + 6 + 20 + 44);
    // 9:16 platforms hit the 320px cap.
    expect(cardMediaHeight(chatCardFrame('tiktok'))).toBe(320);
    expect(cardMediaHeight(chatCardFrame('youtube_shorts'))).toBe(320);
  });
});
