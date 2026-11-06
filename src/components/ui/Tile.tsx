import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { cn } from '@/lib/cn';
import { PressableRow } from '@/components/ui/PressableRow';
import { textRole } from '@/components/ui/Text';

/**
 * The whole tile as one tap surface: the thumbnail and the caption sit inside
 * one PressableRow (the hover and press overlay, the focus line, lit-selected
 * when chosen). The ⋯ stays on the title line but outside the surface
 * (buttons never nest): the title line keeps its box free and the ⋯ is laid
 * over it. The surface's attributes (aria-label, pointer, key and
 * context-menu handlers, aria-pressed, data-*) are forwarded as they are; the
 * part owns every class.
 */
export interface TilePress extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'className' | 'children' | 'type'
> {
  /** Ref to the tap surface's <button> (a menu anchors to it). */
  buttonRef?: Ref<HTMLButtonElement> | undefined;
  /** Current / chosen tile: lit-selected. */
  selected?: boolean;
}

export interface TileProps {
  /** The picture (or the no-picture placeholder), square by default. */
  thumbnail: ReactNode;
  /** Caption title (secondary role, one line). */
  title: ReactNode;
  /** Caption meta line (meta role). Kept even when there is no preview. */
  meta?: ReactNode;
  /** The ⋯ on the title line (an ActionMenu; its trigger applies the trailing rule). */
  more?: ReactNode;
  /** Overlays, corners only: top-left / top-right / bottom-left / bottom-right. */
  corners?: Partial<Record<'tl' | 'tr' | 'bl' | 'br', ReactNode>>;
  /** The thumbnail's aspect (square default). */
  aspect?: 'square' | 'portrait' | 'video';
  /** The tile opens something: the whole tile is one tap surface. */
  press?: TilePress;
  className?: string;
}

const ASPECT = {
  square: 'aspect-square',
  portrait: 'aspect-[4/5]',
  video: 'aspect-video',
} as const;
const CORNER = {
  tl: 'left-0 top-0',
  tr: 'right-0 top-0',
  bl: 'bottom-0 left-0',
  br: 'bottom-0 right-0',
} as const;

/** The empty meta line keeps its height (a no-break space). */
const META_HOLD = ' ';

/**
 * The one tile (Assets, chat people and group tiles, plan week cards). The
 * thumbnail is radius 8; the caption sits below it: title + meta, the ⋯ on the
 * title line. Tiles in a row share height (h-full, the caption reserves its two
 * lines). Overlays live only at the corners.
 */
export function Tile({
  thumbnail,
  title,
  meta,
  more,
  corners,
  aspect = 'square',
  press,
  className,
}: TileProps) {
  const hasMore = more !== undefined && more !== null;
  // Spans throughout: with `press` the thumbnail and caption sit inside a button.
  const thumb = (
    <span className={cn('relative block overflow-hidden rounded-lg', ASPECT[aspect])}>
      {thumbnail}
      {corners !== undefined
        ? (Object.keys(corners) as Array<keyof typeof CORNER>).map((at) =>
            corners[at] !== undefined && corners[at] !== null ? (
              <span key={at} data-tile-corner={at} className={cn('absolute', CORNER[at])}>
                {corners[at]}
              </span>
            ) : null,
          )
        : null}
    </span>
  );
  const caption = (titleEnd: ReactNode) => (
    <span className="flex min-w-0 flex-col">
      <span className="flex min-w-0 items-center gap-2">
        <span className={textRole('secondary', 'min-w-0 flex-1 text-fg')}>{title}</span>
        {titleEnd}
      </span>
      <span className={textRole('meta', 'truncate')}>{meta ?? META_HOLD}</span>
    </span>
  );
  if (press === undefined) {
    return (
      <div data-tile="" className={cn('flex h-full min-w-0 flex-col gap-2', className)}>
        {thumb}
        {caption(
          hasMore ? (
            <span data-tile-more="" className="-my-3 flex shrink-0">
              {more}
            </span>
          ) : null,
        )}
      </div>
    );
  }
  const { buttonRef, selected = false, ...surface } = press;
  return (
    <div data-tile="" className={cn('relative flex h-full min-w-0 flex-col', className)}>
      <PressableRow
        {...surface}
        buttonRef={buttonRef}
        data-tile-press=""
        className={cn('flex h-full min-w-0 flex-col gap-2', selected && 'lit-selected')}
      >
        {thumb}
        {/* The title line keeps the ⋯'s box free (44 tall in the line, 32 of
            it inside the edge; the trailing rule pulls the rest out). */}
        {caption(hasMore ? <span aria-hidden="true" className="-my-3 h-11 w-8 shrink-0" /> : null)}
      </PressableRow>
      {hasMore ? (
        // The ⋯ over that box: the caption's two lines mirrored (title line,
        // meta line) at the tile's foot, so it sits on the title line exactly.
        <span className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-end">
          <span className="flex items-center">
            <span data-tile-more="" className="pointer-events-auto -my-3 flex shrink-0">
              {more}
            </span>
          </span>
          <span aria-hidden="true" className={textRole('meta')}>
            {META_HOLD}
          </span>
        </span>
      ) : null}
    </div>
  );
}
