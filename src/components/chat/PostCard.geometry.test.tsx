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

// One fixed shape (28 Oct), on ui/ChatCard: the loading box and the loaded
// card render the same rows, every one a fixed size, whatever the post holds,
// so a card filling in never moves a row: the one-line title (heading role),
// the meta row (h-5), the media box (the workspace platform's frame) and the
// 44 action row. postCardHeight adds them up.

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

/**
 * The fixed rows a card's markup paints, in order: the media box's px height,
 * the h-5 meta row, the 44 action row, the time row. Equal shapes = equal
 * outer heights (ChatCard's inset and gaps are the same on every card).
 */
function shape(html: string): string {
  const media = /data-card-media=""[^>]*height:([\d.]+)px/.exec(html)?.[1] ?? 'none';
  const meta = /data-chat-card-meta=""[^>]*><span class="[^"]*\bh-5\b/.test(html);
  const actions = /data-chat-card-actions=""[^>]*min-h-11/.test(html);
  const time = html.includes('data-chat-card-time');
  if (!html.includes('data-chat-card=""')) throw new Error(`no ChatCard in ${html.slice(0, 200)}`);
  return `media ${media} / meta-row ${String(meta)} / actions ${String(actions)} / time ${String(time)}`;
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
        const expected = shape(skeleton(platform));
        expect(expected).toBe(
          `media ${cardMediaHeight(chatCardFrame(platform))} / meta-row true / actions true / time false`,
        );
        for (const [name, post] of cases(platform)) {
          const html = loaded(post, platform);
          expect(shape(html), name).toBe(expected);
          // The title is one heading line (truncated), whatever its length.
          expect(html, name).toMatch(/text-lg font-semibold[^"]*truncate/);
          expect(html, name).not.toContain('line-clamp-2');
        }
      });
    }
  }

  it('the side not known yet keeps the 44 action row (no wording), same shape', () => {
    const post = cases('instagram')[0]![1];
    const known = loaded(post, 'instagram', true);
    const unknown = loaded(post, 'instagram', false);
    expect(shape(unknown)).toBe(shape(known));
    expect(unknown).not.toContain('data-card-footer');
    expect(unknown).toMatch(/data-chat-card-actions=""[^>]*min-h-11/);
  });

  it('a not-visible card and a couldn’t-load card take the same box', () => {
    const expected = shape(skeleton('instagram'));
    const hidden = renderToStaticMarkup(
      <MemoryRouter>
        <SharedPostCardList
          views={sharedPostViews(['gone'], new Map(), new Map())}
          side="agency"
          platform="instagram"
        />
      </MemoryRouter>,
    );
    expect(shape(hidden)).toBe(expected);
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
    expect(failed).toMatch(/Couldn.{1,6}t load this post\./);
    expect(failed).toMatch(/<button[^>]*>Retry<\/button>/);
    expect(shape(failed)).toBe(expected);
  });

  it('the time row goes in the last card only, the skeleton and the card alike', () => {
    const post = cases('instagram')[0]![1];
    const views = sharedPostViews([post.id], indexPostsById([post]), new Map());
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <SharedPostCardList
          views={views}
          side="agency"
          platform="instagram"
          inBubble={false}
          cardMeta={<span>2:14 PM</span>}
        />
      </MemoryRouter>,
    );
    const box = renderToStaticMarkup(
      <PostCardSkeleton platform="instagram" cardMeta={<span>2:14 PM</span>} />,
    );
    expect(shape(html)).toBe(shape(box));
    expect(shape(html)).toContain('time true');
  });

  it('the loading box is the card surface, with bones and no pulse', () => {
    const html = skeleton('instagram');
    expect(html).toContain('lit-bubble-other');
    expect(html).toContain('data-bone');
    expect(html).not.toContain('animate-pulse');
  });

  it('the fixed parts add up: inset, title, meta row, media box, action row (and time)', () => {
    const frame = chatCardFrame('instagram');
    // 4:5 at the 264px inner width (288 less the 12 inset twice) is 330: capped.
    expect(cardMediaHeight(frame)).toBe(320);
    expect(postCardHeight(frame, 'touch')).toBe(24 + 20 + 4 + 20 + 8 + 320 + 8 + 44);
    expect(postCardHeight(frame, 'laptop')).toBe(postCardHeight(frame, 'touch'));
    expect(postCardHeight(frame, 'touch', true)).toBe(postCardHeight(frame, 'touch') + 8 + 15);
    expect(cardTitleHeight('touch')).toBe(20);
    // 9:16 platforms hit the 320px cap.
    expect(cardMediaHeight(chatCardFrame('tiktok'))).toBe(320);
    expect(cardMediaHeight(chatCardFrame('youtube_shorts'))).toBe(320);
  });
});
