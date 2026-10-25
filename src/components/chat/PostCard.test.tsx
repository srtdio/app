import { afterEach, describe, expect, it, vi } from 'vitest';

// The card must never obtain a navigator: a tap opens the sheet instead.
const navigate = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { Client } from '@srtdio/rpc';
import type { CardFirstMedia, PostCardRow } from '../../../packages/posts/src/reads';
import { createLongPressController } from '@/components/ui/useLongPress';
import { PostSheetActions, talkAboutLabel } from '@/components/chat/PostSheet';
import { sheetActions } from '@/components/chat/post-sheet';
import {
  CARD_HOLD,
  CARD_SKELETON,
  NotVisibleCard,
  cardTapHandlers,
  POST_CARD,
  SHARED_CARD,
  SharedPostCardList,
  cardFrame,
  loadPostCardBatch,
  readApproverRoles,
  type CardContext,
} from '@/components/chat/PostCard';
import {
  NOT_VISIBLE_BODY,
  NOT_VISIBLE_TITLE,
  indexPostsById,
  sharedPostViews,
} from '@/components/chat/post-card';

/** Pin the device locale: Intl.DateTimeFormat with no locale resolves to `locale`. */
function deviceLocale(locale: string): void {
  const Real = Intl.DateTimeFormat;
  vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (
    requested?: string | string[],
    options?: Intl.DateTimeFormatOptions,
  ) {
    return new Real(requested ?? locale, options);
  } as typeof Intl.DateTimeFormat);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('NotVisibleCard', () => {
  const html = renderToStaticMarkup(<NotVisibleCard />);

  it('renders the neutral title and one line of copy', () => {
    expect(NOT_VISIBLE_TITLE).toBe('Post not visible to you yet');
    expect(NOT_VISIBLE_BODY).toBe('It will appear here once it is shared for review');
    expect(html).toContain(NOT_VISIBLE_TITLE);
    expect(html).toContain(NOT_VISIBLE_BODY);
  });

  it('has no link, button or thumbnail, and uses neutral tokens', () => {
    expect(html).not.toMatch(/<a\b|<button\b|<svg\b|<img\b/);
    expect(html).toContain('bg-panel-2');
    expect(html).toContain('border-border');
    expect(html).toContain('text-fg-2');
  });

  it('keeps the visible card box size', () => {
    expect(html).toContain('w-[240px]');
    expect(html).toContain('min-h-[44px]');
    expect(SHARED_CARD).toContain('bg-panel');
  });
});

/** A photo first media with no stored size (an older upload). */
const IMAGE: CardFirstMedia = { assetVersionId: 'v1', kind: 'image', width: null, height: null };

function cardRow(id: string, over: Partial<PostCardRow> = {}): PostCardRow {
  return {
    id,
    number: 12,
    title: `Post ${id}`,
    platform: 'instagram',
    format: 'carousel',
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

const CONTEXT: CardContext = { side: 'agency', timeZone: 'UTC' };

/** A KEY-N code anywhere in the visible text (tags stripped). */
const CODE = /\b[A-Z]{2,}-\d+\b/;
function visibleText(html: string): string {
  return html.replace(/<[^>]*>/g, ' ');
}

function render(
  ids: string[],
  posts: PostCardRow[],
  context: Partial<CardContext> = {},
  names: Map<string, string> = new Map(),
): string {
  const views = sharedPostViews(ids, indexPostsById(posts), names);
  return renderToStaticMarkup(
    <MemoryRouter>
      <SharedPostCardList views={views} {...CONTEXT} {...context} />
    </MemoryRouter>,
  );
}

describe('SharedPostCardList', () => {
  it('no thumbnail: no media box, the title alone with no KEY-N code', () => {
    const html = render(['p1'], [cardRow('p1', { title: 'Launch teaser' })]);
    expect(html).not.toContain('data-card-media');
    expect(html).not.toContain('data-frame-ratio');
    expect(html).toMatch(/title="Launch teaser">Launch teaser<\/span>/);
    expect(html).not.toContain('data-card-ref');
    expect(visibleText(html)).not.toMatch(CODE);
  });

  it('thumbnail: platform-framed media box with format and slides pills; no KEY pill', () => {
    const html = render(
      ['p1'],
      [cardRow('p1', { thumbnailAssetVersionId: 'v1', firstMedia: IMAGE, mediaCount: 3 })],
    );
    expect(html).toContain('data-card-media');
    // Instagram carousel before any size is known: the 4:5 portrait default.
    expect(html).toContain('data-frame-ratio="0.8"');
    expect(html).toContain('width:min(100%, calc(320px * 0.8))');
    expect(html).not.toContain('data-card-pill-ref');
    expect(html).not.toContain('data-card-ref');
    expect(visibleText(html)).not.toMatch(CODE);
    expect(html).toContain('Carousel');
    expect(html).toContain('3 slides');
    expect(html).not.toContain('Reel');
  });

  it('video media shows the play pill: Reel for a video post', () => {
    const html = render(
      ['p1'],
      [
        cardRow('p1', {
          thumbnailAssetVersionId: 'v1',
          firstMedia: IMAGE,
          mediaCount: 1,
          hasVideo: true,
          format: 'video',
        }),
      ],
    );
    expect(html).toContain('Reel');
    expect(html).not.toContain('slides');
  });

  it('is a tappable dialog opener the bubble long-press ignores (data-msg-link)', () => {
    const html = render(['p1'], [cardRow('p1')]);
    expect(html).toContain('role="button"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).not.toContain('role="link"');
    expect(html).not.toMatch(/<a\b|href=/);
    expect(html).toContain('data-msg-link=""');
    expect(html).toContain('tabindex="0"');
    expect(POST_CARD).toContain('bg-panel');
  });

  it('renders no sheet until tapped, and never reaches for the router', () => {
    navigate.mockClear();
    const html = render(['p1'], [cardRow('p1', { stage: 'review' })], { side: 'client' });
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('data-post-sheet');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('review footer by side', () => {
    const post = [cardRow('p1', { stage: 'review' })];
    const client = render(['p1'], post, { side: 'client' });
    expect(client).toContain('Waiting on you');
    expect(client).toContain('Review');
    expect(client).toContain('text-accent');
    const agency = render(['p1'], post, { side: 'agency' });
    expect(agency).toContain('Waiting on approvers');
    expect(agency).toContain('>Open<');
    expect(render(['p1'], post, { side: 'unknown' })).toContain('In review');
  });

  it('approved footer: first name and time, else the stage date fallback', () => {
    const named = (): string =>
      render(
        ['p1'],
        [
          cardRow('p1', {
            stage: 'approved',
            approved_by: 'u1',
            approved_at: '2026-09-21T14:05:00Z',
          }),
        ],
        {},
        new Map([['u1', 'Asha Rao']]),
      );
    deviceLocale('en-IN');
    expect(named()).toContain('Approved by Asha · 21 Sep, 2:05 PM');
    vi.restoreAllMocks();
    deviceLocale('en-GB');
    expect(named()).toContain('Approved by Asha · 21 Sep, 2:05 PM');
    const fallback = render(['p1'], [cardRow('p1', { stage: 'approved' })]);
    expect(fallback).toContain('Approved · 20 Sep');
  });

  it('shows the target date when set', () => {
    const html = render(['p1'], [cardRow('p1', { target_date: '2026-10-02T09:00:00Z' })]);
    expect(html).toMatch(/data-card-target="">2 Oct</);
  });

  it('preserves postIds order and keeps not-visible cards in place', () => {
    const html = render(['p3', 'p1', 'p2'], [cardRow('p1'), cardRow('p3')]);
    const p3 = html.indexOf('Post p3');
    const p1 = html.indexOf('Post p1');
    const hidden = html.indexOf(NOT_VISIBLE_TITLE);
    expect(p3).toBeGreaterThan(-1);
    expect(p3).toBeLessThan(p1);
    expect(p1).toBeLessThan(hidden);
  });

  it('the footer is a 44px row with a hairline top border', () => {
    const html = render(['p1'], [cardRow('p1')]);
    expect(html).toMatch(/data-card-footer=""[^>]*h-\[44px\][^>]*border-t border-border/);
    expect(CARD_SKELETON).toContain('w-[240px]');
  });
});

interface TableResult {
  data: unknown;
  error: { message: string } | null;
}

function makeClient(results: Record<string, TableResult>) {
  const from = vi.fn((table: string) => {
    const b: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'in', 'is', 'like', 'order']) b[method] = () => b;
    b.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(results[table] ?? { data: [], error: null }).then(resolve);
    return b;
  });
  return { client: { from } as unknown as Client, from };
}

describe('loadPostCardBatch', () => {
  it('one batch = posts + attachments + ONE users read + ONE roles read, regardless of card count', async () => {
    const { client, from } = makeClient({
      posts: {
        data: [
          { ...cardRow('p1', { approved_by: 'u1' }) },
          { ...cardRow('p2', { approved_by: 'u1' }) },
          { ...cardRow('p3', { approved_by: 'u2' }) },
        ],
        error: null,
      },
      asset_attachments: { data: [], error: null },
      users: {
        data: [{ id: 'u1', display_name: 'Asha Rao', avatar_url: null }],
        error: null,
      },
      workspace_members: { data: [{ user_id: 'u1', role: 'agency' }], error: null },
    });
    const batch = await loadPostCardBatch(client, 'ws', ['p1', 'p2', 'p3']);
    expect(from.mock.calls.map((c) => c[0]).sort()).toEqual(
      ['asset_attachments', 'posts', 'users', 'workspace_members'].sort(),
    );
    expect(batch?.posts).toHaveLength(3);
    expect(batch?.names.get('u1')).toBe('Asha Rao');
    expect(batch?.roles.get('u1')).toBe('agency');
  });

  it('a failed role read keeps the names and drops only the roles', async () => {
    const { client } = makeClient({
      posts: { data: [cardRow('p1', { approved_by: 'u1' })], error: null },
      users: { data: [{ id: 'u1', display_name: 'Asha Rao', avatar_url: null }], error: null },
      workspace_members: { data: null, error: { message: 'boom' } },
    });
    const batch = await loadPostCardBatch(client, 'ws', ['p1']);
    expect(batch?.names.get('u1')).toBe('Asha Rao');
    expect(batch?.roles.size).toBe(0);
  });

  it('skips the name lookup when no post has an approver', async () => {
    const { client, from } = makeClient({
      posts: { data: [cardRow('p1')], error: null },
    });
    await loadPostCardBatch(client, 'ws', ['p1']);
    expect(from.mock.calls.map((c) => c[0])).toEqual(['posts', 'asset_attachments']);
  });

  it('returns null when the posts read fails', async () => {
    const { client } = makeClient({ posts: { data: null, error: { message: 'boom' } } });
    expect(await loadPostCardBatch(client, 'ws', ['p1'])).toBeNull();
  });
});

describe('cardTapHandlers', () => {
  it('a tap opens the sheet and does not navigate', () => {
    navigate.mockClear();
    const openSheet = vi.fn();
    cardTapHandlers(openSheet).onClick();
    expect(openSheet).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('Enter opens the sheet (default prevented); other keys do nothing', () => {
    const openSheet = vi.fn();
    const handlers = cardTapHandlers(openSheet);
    const enter = { key: 'Enter', preventDefault: vi.fn() };
    handlers.onKeyDown(enter);
    expect(enter.preventDefault).toHaveBeenCalledTimes(1);
    expect(openSheet).toHaveBeenCalledTimes(1);
    const space = { key: 'a', preventDefault: vi.fn() };
    handlers.onKeyDown(space);
    expect(space.preventDefault).not.toHaveBeenCalled();
    expect(openSheet).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('card long-press: talk about the post', () => {
  /** The card's wiring: the hold controller plus the tap handlers reading its flag. */
  function card(): {
    onTalkAbout: ReturnType<typeof vi.fn>;
    openSheet: ReturnType<typeof vi.fn>;
    press: (holdMs: number, moveX?: number) => void;
  } {
    const onTalkAbout = vi.fn();
    const openSheet = vi.fn();
    const hold = createLongPressController({ onLongPress: onTalkAbout, ...CARD_HOLD });
    const tap = cardTapHandlers(openSheet, hold.consumeClickSuppression);
    const press = (holdMs: number, moveX = 0): void => {
      hold.handlers.onPointerDown({ clientX: 0, clientY: 0, pointerType: 'touch' });
      if (moveX !== 0) hold.handlers.onPointerMove({ clientX: moveX, clientY: 0 });
      vi.advanceTimersByTime(holdMs);
      hold.handlers.onPointerUp();
      tap.onClick();
    };
    return { onTalkAbout, openSheet, press };
  }

  it('holds 450 ms within 10 px', () => {
    expect(CARD_HOLD).toEqual({ thresholdMs: 450, moveTolerancePx: 10 });
  });

  it('a hold calls onTalkAbout and the click that ends it does not open the sheet', () => {
    vi.useFakeTimers();
    const { onTalkAbout, openSheet, press } = card();
    press(450);
    expect(onTalkAbout).toHaveBeenCalledTimes(1);
    expect(openSheet).not.toHaveBeenCalled();
    // The next plain tap opens the sheet again.
    press(100);
    expect(openSheet).toHaveBeenCalledTimes(1);
    expect(onTalkAbout).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('a tap opens the sheet; a drag past 10 px never talks about the post', () => {
    vi.useFakeTimers();
    const { onTalkAbout, openSheet, press } = card();
    press(200);
    expect(openSheet).toHaveBeenCalledTimes(1);
    expect(onTalkAbout).not.toHaveBeenCalled();
    press(600, 11);
    expect(onTalkAbout).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('a card carries no KEY button: nothing on it opens the thread', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <SharedPostCardList
          views={sharedPostViews(['p1'], indexPostsById([cardRow('p1')]))}
          {...CONTEXT}
          onTalkAbout={() => {}}
        />
      </MemoryRouter>,
    );
    expect(html).not.toContain('data-card-ref');
    expect(html).not.toContain('Open the thread');
    expect(html).not.toMatch(/<button\b/);
    expect(visibleText(html)).not.toMatch(CODE);
  });
});

describe('post sheet: Talk about', () => {
  function actions(onTalkAbout?: () => void): string {
    const post = cardRow('p1');
    return renderToStaticMarkup(
      <PostSheetActions
        set={sheetActions('agency', post, 'UTC')}
        mode={{ kind: 'actions' }}
        subject="Post p1"
        approverName={null}
        mediaCount={0}
        targetDate=""
        busy={false}
        error={null}
        onAction={vi.fn()}
        onConfirm={vi.fn()}
        onBack={vi.fn()}
        onTalkAbout={onTalkAbout}
      />,
    );
  }

  it('shows a soft "Talk about this post" button when the thread offers it', () => {
    expect(talkAboutLabel()).toBe('Talk about this post');
    const html = actions(() => {});
    expect(html).toMatch(/data-sheet-talk-about=""[^>]*>Talk about this post</);
    const talk = /<button[^>]*data-sheet-talk-about=""[^>]*>/.exec(html)?.[0] ?? '';
    expect(talk).toContain('bg-accent-soft');
    expect(talk).toContain('text-accent');
    expect(talk).toContain('h-11');
  });

  it('is absent without the hook', () => {
    expect(actions()).not.toContain('Talk about');
  });
});

describe('readApproverRoles', () => {
  it('settles empty at its cap when the read never answers', async () => {
    const from = vi.fn(() => {
      const b: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'in']) b[method] = () => b;
      b.then = () => new Promise(() => {});
      return b;
    });
    const roles = await readApproverRoles(
      { from } as unknown as Client,
      'ws',
      ['u1'],
      undefined,
      5,
    );
    expect(roles.size).toBe(0);
  });

  it('skips the read for no approvers', async () => {
    const from = vi.fn();
    await readApproverRoles({ from } as unknown as Client, 'ws', []);
    expect(from).not.toHaveBeenCalled();
  });
});

describe('chat post card platform frame', () => {
  it('the ratio follows the platform and format, 240px wide and capped at 320px tall', () => {
    expect(
      cardFrame({ platform: 'instagram', format: 'reel', firstMedia: null })?.ratio,
    ).toBeCloseTo(9 / 16);
    expect(
      cardFrame({ platform: 'instagram', format: 'single_image', firstMedia: null })?.ratio,
    ).toBeCloseTo(0.8);
    expect(
      cardFrame({ platform: 'x', format: 'single_image', firstMedia: null })?.ratio,
    ).toBeCloseTo(16 / 9);
    const reel = render(
      ['p1'],
      [
        cardRow('p1', {
          format: 'reel',
          thumbnailAssetVersionId: 'v1',
          firstMedia: IMAGE,
          mediaCount: 1,
        }),
      ],
    );
    // 9:16 hits the 320px cap: 320 x 0.5625 = 180px wide inside the 240px card.
    expect(reel).toContain('width:min(100%, calc(320px * 0.5625))');
    expect(reel).toContain('w-[240px]');
    const shorts = render(
      ['p1'],
      [
        cardRow('p1', {
          platform: 'youtube_shorts',
          format: 'short',
          thumbnailAssetVersionId: 'v1',
          firstMedia: IMAGE,
          mediaCount: 1,
        }),
      ],
    );
    expect(shorts).toContain('data-frame-bands="blur"');
    expect(shorts).toContain('bg-black');
  });

  it('a text or link post keeps the non-media card even with an attachment', () => {
    for (const format of ['text', 'link']) {
      expect(cardFrame({ platform: 'linkedin', format, firstMedia: IMAGE })).toBeNull();
      const html = render(
        ['p1'],
        [
          cardRow('p1', {
            platform: 'linkedin',
            format,
            thumbnailAssetVersionId: 'v1',
            firstMedia: IMAGE,
            mediaCount: 1,
          }),
        ],
      );
      expect(html).not.toContain('data-card-media');
      expect(html).not.toContain('data-card-ref');
      expect(visibleText(html)).not.toMatch(CODE);
    }
  });
});
