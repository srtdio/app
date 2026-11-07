// The post drawn the way its platform shows it: a feed card in the
// platform's own light colours (Instagram, Facebook, LinkedIn, X, Threads) or
// a black full screen (Reel, Story, TikTok, Shorts). Chrome only: the
// workspace avatar and name, the time, the clamped caption, the media and the
// platform's action glyphs, static and hidden from assistive tech. Colours are
// the named pv-* tokens (platform-look.ts); no logos, no wordmarks. Pure
// render: the media URLs come from the body (or the page's presign cache).

import { useState } from 'react';
import type { CSSProperties, ReactElement, ReactNode, UIEvent } from 'react';
import type { GalleryItem, PostPlatform } from '@srtdio/posts';
import { Avatar } from '@/components/ui/Avatar';
import { textRole } from '@/components/ui/Text';
import {
  ICON_SIZE,
  IconArrowUpRight,
  IconBookmark,
  IconChat,
  IconForward,
  IconRotateCcw,
  IconStar,
} from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { formatAgo } from '@/lib/time';
import type { PresignCache } from '@/lib/asset-presign';
import type { CropWindow } from '@/components/preview/preview-math';
import {
  FEED_ACTIONS,
  FEED_LOOK,
  RAIL_ACTIONS,
  STORY_ACTIONS,
  avatarColumn,
  captionFirst,
  feedFamily,
  headerShowsTime,
  type ActionGlyph,
} from '@/components/preview/platform-look';
import { useMediaUrl } from '@/components/preview/use-media-url';

function clampStyle(lines: number): CSSProperties {
  return {
    display: '-webkit-box',
    WebkitLineClamp: lines,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  };
}

// ---------------------------------------------------------------- glyphs

function Glyph({ glyph }: { glyph: ActionGlyph }): ReactElement {
  const size = ICON_SIZE.control;
  switch (glyph) {
    case 'like':
      return <IconStar size={size} />;
    case 'comment':
      return <IconChat size={size} />;
    case 'share':
      return <IconForward size={size} />;
    case 'send':
      return <IconArrowUpRight size={size} />;
    case 'repost':
      return <IconRotateCcw size={size} />;
    case 'save':
      return <IconBookmark size={size} />;
  }
}

/** A static row (or rail) of action glyphs: drawn only, never a control. */
function Glyphs({
  glyphs,
  className,
}: {
  glyphs: readonly ActionGlyph[];
  className: string;
}): ReactElement {
  return (
    <span aria-hidden="true" data-preview-actions="" className={className}>
      {glyphs.map((glyph) => (
        <Glyph key={glyph} glyph={glyph} />
      ))}
    </span>
  );
}

// ---------------------------------------------------------------- media stage

/** One photo or video of the post, in order. */
export interface StageSlide {
  key: string;
  item: GalleryItem;
  kind: 'image' | 'video';
  /** The draft's local object URL; used as-is, never presigned. */
  localUrl: string | null;
}

export interface StageProps {
  slides: readonly StageSlide[];
  /** The first slide's resolved URL (the body measures it). */
  firstUrl: string | null;
  cache?: PresignCache | undefined;
  presignEnabled: boolean;
  fit: 'cover' | 'contain';
  bands: 'none' | 'black' | 'blur';
  /** Show cut: the whole first slide fit in the frame with the cut strips shaded. */
  cut: { window: CropWindow; mediaRatio: number; frameRatio: number } | null;
  /** Several slides: swiped one by one, with the "{i} / {n}" pill. */
  carousel: boolean;
  /** Something is attached (else the empty line shows). */
  hasMedia: boolean;
  onMeasure: (src: string | null, w: number, h: number) => void;
}

type ObjectFit = 'object-cover' | 'object-contain' | 'object-fill';

function MediaEl({
  kind,
  url,
  fit,
  onMeasure,
}: {
  kind: 'image' | 'video';
  url: string;
  fit: ObjectFit;
  onMeasure?: ((src: string | null, w: number, h: number) => void) | undefined;
}): ReactElement {
  if (kind === 'video') {
    return (
      <video
        src={url}
        muted
        playsInline
        preload="metadata"
        aria-hidden
        className={cn('h-full w-full', fit)}
        onLoadedMetadata={(event) =>
          onMeasure?.(
            event.currentTarget.getAttribute('src'),
            event.currentTarget.videoWidth,
            event.currentTarget.videoHeight,
          )
        }
      />
    );
  }
  return (
    <img
      src={url}
      alt=""
      className={cn('h-full w-full', fit)}
      // An image already decoded (cached, or loaded before a reset) fires no
      // load event: measure it as it mounts.
      ref={(el) => {
        if (el !== null && el.complete && onMeasure !== undefined) {
          onMeasure(el.getAttribute('src'), el.naturalWidth, el.naturalHeight);
        }
      }}
      onLoad={(event) =>
        onMeasure?.(
          event.currentTarget.getAttribute('src'),
          event.currentTarget.naturalWidth,
          event.currentTarget.naturalHeight,
        )
      }
    />
  );
}

/** A later carousel slide: resolves its own URL through the same cache. */
function LaterSlide(props: {
  slide: StageSlide;
  cache?: PresignCache | undefined;
  presignEnabled: boolean;
  fit: ObjectFit;
}): ReactElement | null {
  const url = useMediaUrl(
    props.slide.item,
    props.slide.kind,
    props.cache,
    props.presignEnabled,
    props.slide.localUrl,
  );
  if (url === null) return null;
  return <MediaEl kind={props.slide.kind} url={url} fit={props.fit} />;
}

/** The shaded strips outside the shown window (fractions of the original). */
function CutStrips({ window: win }: { window: CropWindow }): ReactElement {
  const pct = (n: number): string => `${n * 100}%`;
  const strips: { key: string; style: CSSProperties }[] = [];
  if (win.x > 0) {
    strips.push({ key: 'left', style: { left: 0, top: 0, bottom: 0, width: pct(win.x) } });
    strips.push({
      key: 'right',
      style: { right: 0, top: 0, bottom: 0, width: pct(1 - win.x - win.w) },
    });
  }
  if (win.y > 0) {
    strips.push({ key: 'top', style: { top: 0, left: 0, right: 0, height: pct(win.y) } });
    strips.push({
      key: 'bottom',
      style: { bottom: 0, left: 0, right: 0, height: pct(1 - win.y - win.h) },
    });
  }
  return (
    <>
      {strips.map((strip) => (
        <span
          key={strip.key}
          aria-hidden="true"
          data-cut-strip={strip.key}
          className="absolute bg-pv-cut"
          style={strip.style}
        />
      ))}
    </>
  );
}

/** The media inside its frame: fills the frame box the chrome draws. */
export function MediaStage(props: StageProps): ReactElement {
  const [active, setActive] = useState(0);
  const first = props.slides[0];
  const fit: ObjectFit = props.fit === 'contain' ? 'object-contain' : 'object-cover';
  const count = props.slides.length;

  function onScroll(event: UIEvent<HTMLDivElement>): void {
    const el = event.currentTarget;
    const at = Math.round(el.scrollLeft / Math.max(1, el.clientWidth));
    setActive(Math.min(count - 1, Math.max(0, at)));
  }

  let body: ReactNode;
  if (first === undefined || props.firstUrl === null) {
    body = (
      <span
        className={textRole(
          'secondary',
          'flex h-full w-full items-center justify-center bg-panel-3 text-fg-3',
        )}
      >
        {props.hasMedia ? 'Loading' : 'Photos and videos show up here.'}
      </span>
    );
  } else if (props.cut !== null) {
    const wide = props.cut.mediaRatio > props.cut.frameRatio;
    body = (
      <span className="absolute inset-0 flex items-center justify-center bg-pv-screen">
        <span
          data-preview-cut-box=""
          className={cn('relative block overflow-hidden', wide ? 'w-full' : 'h-full')}
          style={{ aspectRatio: String(props.cut.mediaRatio) }}
        >
          <MediaEl
            kind={first.kind}
            url={props.firstUrl}
            fit="object-fill"
            onMeasure={props.onMeasure}
          />
          <CutStrips window={props.cut.window} />
        </span>
      </span>
    );
  } else if (props.carousel && count > 1) {
    body = (
      <>
        <div
          onScroll={onScroll}
          aria-roledescription="carousel"
          data-preview-track=""
          className="absolute inset-0 flex snap-x snap-mandatory overflow-x-auto overscroll-x-contain"
        >
          {props.slides.map((slide, index) => (
            <div key={slide.key} className="relative h-full w-full shrink-0 snap-center">
              {index === 0 && props.firstUrl !== null ? (
                <MediaEl
                  kind={slide.kind}
                  url={props.firstUrl}
                  fit={fit}
                  onMeasure={props.onMeasure}
                />
              ) : (
                <LaterSlide
                  slide={slide}
                  cache={props.cache}
                  presignEnabled={props.presignEnabled}
                  fit={fit}
                />
              )}
            </div>
          ))}
        </div>
        <span
          data-preview-pill=""
          className={textRole(
            'meta',
            'pointer-events-none absolute right-2 top-2 rounded-pill bg-overlay-badge px-2 py-0.5 text-overlay-fg lit-pill',
          )}
        >
          {`${active + 1} / ${count}`}
        </span>
      </>
    );
  } else {
    body = <MediaEl kind={first.kind} url={props.firstUrl} fit={fit} onMeasure={props.onMeasure} />;
  }

  return (
    <div
      data-preview-stage=""
      className={cn('absolute inset-0 overflow-hidden', props.bands === 'black' && 'bg-pv-screen')}
    >
      {props.bands === 'blur' && first !== undefined && props.firstUrl !== null ? (
        <div aria-hidden className="absolute inset-0 scale-110 opacity-70 blur-xl">
          <MediaEl kind={first.kind} url={props.firstUrl} fit="object-cover" />
        </div>
      ) : null}
      <div className="absolute inset-0 flex items-center justify-center">{body}</div>
    </div>
  );
}

// ---------------------------------------------------------------- chrome

export interface MockProps {
  platform: PostPlatform;
  /** The account on the mock: the workspace name. */
  handle: string;
  caption: string;
  /** Caption lines before the clamp (feed 3, full screen 2). */
  clampLines: number;
  /** The media frame (ratio w / h) and the stage inside it; null for a text post. */
  media: { ratio: number; stage: ReactNode } | null;
}

/** The workspace avatar and name, the way every mock heads the post. */
function Who({ handle }: { handle: string }): ReactElement {
  return (
    <>
      <Avatar name={handle.trim()} role="header" decorative />
      <span className={textRole('label', 'min-w-0 truncate font-semibold')}>{handle}</span>
    </>
  );
}

/** A feed post in the platform's own light card. */
export function FeedMock(props: MockProps): ReactElement {
  const family = feedFamily(props.platform);
  const look = FEED_LOOK[family];
  const actions = FEED_ACTIONS[family];
  const column = avatarColumn(family);
  const time = headerShowsTime(family) ? (
    <span className={textRole('meta', cn('shrink-0', look.ink2))}>{formatAgo(new Date())}</span>
  ) : null;

  // The caption under the clamp; Instagram leads it with the name in bold.
  const caption = (pad: string | null): ReactNode =>
    props.caption !== '' ? (
      <p
        data-preview-caption=""
        className={textRole('body', cn('[overflow-wrap:anywhere]', pad))}
        style={clampStyle(props.clampLines)}
      >
        {family === 'instagram' ? (
          <>
            <span className="font-semibold">{props.handle}</span> {props.caption}
          </>
        ) : (
          props.caption
        )}
      </p>
    ) : null;

  const media =
    props.media !== null ? (
      <div
        data-preview-media=""
        className={cn(
          'relative w-full overflow-hidden',
          column && cn('rounded-xl border', look.line),
        )}
        style={{ aspectRatio: String(props.media.ratio) }}
      >
        {props.media.stage}
      </div>
    ) : null;

  const glyphs = (
    <span
      aria-hidden="true"
      data-preview-actions=""
      className={cn(
        'flex min-h-11 items-center',
        actions.spread ? 'justify-between' : 'gap-4',
        !column && 'px-3',
        family === 'facebook' || family === 'linkedin' ? cn('border-t', look.line) : null,
      )}
    >
      {actions.lead.map((glyph) => (
        <Glyph key={glyph} glyph={glyph} />
      ))}
      {actions.trail.length > 0 ? (
        <span className="ml-auto flex items-center gap-4">
          {actions.trail.map((glyph) => (
            <Glyph key={glyph} glyph={glyph} />
          ))}
        </span>
      ) : null}
    </span>
  );

  if (column) {
    return (
      <figure
        aria-label="Feed preview"
        data-preview-platform={props.platform}
        data-preview-chrome={`feed-${family}`}
        className={cn('flex gap-3 overflow-hidden rounded-xl bg-pv-card p-3 lit-card', look.ink)}
      >
        <Avatar name={props.handle.trim()} role="header" decorative />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <span className="flex min-w-0 items-center gap-2">
            <span className={textRole('label', 'min-w-0 truncate font-semibold')}>
              {props.handle}
            </span>
            {time}
          </span>
          {caption(null)}
          {media}
          {glyphs}
        </div>
      </figure>
    );
  }

  const header = (
    <span className="flex min-w-0 items-center gap-2 px-3 py-2">
      <Avatar name={props.handle.trim()} role="header" decorative />
      <span className="flex min-w-0 flex-col">
        <span className={textRole('label', 'min-w-0 truncate font-semibold')}>{props.handle}</span>
        {time}
      </span>
    </span>
  );

  const card = (
    <figure
      aria-label="Feed preview"
      data-preview-platform={props.platform}
      data-preview-chrome={`feed-${family}`}
      className={cn(
        'flex flex-col overflow-hidden bg-pv-card',
        look.ink,
        look.page === null ? 'rounded-xl lit-card' : 'rounded-lg',
      )}
    >
      {header}
      {captionFirst(family) ? (
        <>
          {caption('px-3 pb-2')}
          {media}
          {glyphs}
        </>
      ) : (
        <>
          {media}
          {glyphs}
          {caption('px-3 pb-3')}
        </>
      )}
    </figure>
  );

  return look.page === null ? (
    card
  ) : (
    <div className={cn('rounded-xl p-2 lit-card', look.page)}>{card}</div>
  );
}

/**
 * A full-screen post: black ground, the media filling its 9:16 (or banded)
 * frame, the name and caption over a fade at the foot and the action rail on
 * the right; a Story heads with its progress line and name instead.
 */
export function FullMock(props: MockProps & { story: boolean; ratio: number }): ReactElement {
  return (
    <figure
      aria-label={props.story ? 'Story preview' : 'Full-screen preview'}
      data-preview-platform={props.platform}
      data-preview-chrome={props.story ? 'story' : 'full'}
      className="relative mx-auto w-full max-w-72 overflow-hidden rounded-2xl bg-pv-screen text-pv-screen-ink lit-media"
      style={{ aspectRatio: String(props.ratio) }}
    >
      {props.media?.stage ?? null}
      {props.story ? (
        <>
          <span className="absolute inset-x-0 top-0 flex flex-col gap-2 p-3">
            <span aria-hidden="true" className="h-0.5 w-full rounded-full bg-pv-screen-ink-2" />
            <span className="flex min-w-0 items-center gap-2">
              <Who handle={props.handle} />
              <span className={textRole('meta', 'shrink-0 text-pv-screen-ink-2')}>
                {formatAgo(new Date())}
              </span>
            </span>
          </span>
          <Glyphs glyphs={STORY_ACTIONS} className="absolute bottom-3 right-3 flex gap-4" />
        </>
      ) : (
        <>
          <Glyphs
            glyphs={RAIL_ACTIONS}
            className="absolute bottom-24 right-3 flex flex-col items-center gap-4"
          />
          <figcaption className="absolute inset-x-0 bottom-0 flex flex-col gap-1 bg-pv-scrim p-3 pr-12 pt-10">
            <span className="flex min-w-0 items-center gap-2">
              <Who handle={props.handle} />
            </span>
            {props.caption !== '' ? (
              <span
                className={textRole('body', '[overflow-wrap:anywhere]')}
                style={clampStyle(props.clampLines)}
              >
                {props.caption}
              </span>
            ) : null}
          </figcaption>
        </>
      )}
    </figure>
  );
}
