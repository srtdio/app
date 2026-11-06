import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { textRole } from '@/components/ui/Text';

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
  className,
}: TileProps) {
  return (
    <div data-tile="" className={cn('flex h-full min-w-0 flex-col gap-2', className)}>
      <div className={cn('relative overflow-hidden rounded-lg', ASPECT[aspect])}>
        {thumbnail}
        {corners !== undefined
          ? (Object.keys(corners) as Array<keyof typeof CORNER>).map((at) =>
              corners[at] !== undefined ? (
                <span key={at} data-tile-corner={at} className={cn('absolute', CORNER[at])}>
                  {corners[at]}
                </span>
              ) : null,
            )
          : null}
      </div>
      <div className="flex min-w-0 flex-col">
        <div className="flex min-w-0 items-center gap-2">
          <span className={textRole('secondary', 'min-w-0 flex-1 text-fg')}>{title}</span>
          {more !== undefined ? <span className="-my-3 flex shrink-0">{more}</span> : null}
        </div>
        <span className={textRole('meta', 'truncate')}>{meta ?? ' '}</span>
      </div>
    </div>
  );
}
