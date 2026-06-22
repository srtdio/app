import type { ReactElement } from 'react';
import { cn } from '@/lib/cn';
import { colorFor } from '@/components/ui/Avatar';
import {
  IconActivity,
  IconBriefs,
  IconCarousel,
  IconImage,
  IconLink,
  IconText,
  IconVideo,
} from '@/components/ui/icons';

interface ThumbTileProps {
  /** Stable id used to pick the deterministic tone (entity id, or the row id). */
  toneKey: string;
  /** 'post' / 'brief' / other; selects which glyph family to show. */
  entityType: string | null;
  /** post.format (text/single_image/carousel/video/link) when known. */
  format: string | null;
}

/**
 * The overlay glyph: a per-format icon for posts, a doc glyph for briefs, and a
 * generic activity glyph for anything else. Reuses the shared icon set; never
 * introduces a new glyph.
 */
function thumbGlyph(entityType: string | null, format: string | null): ReactElement {
  if (entityType === 'brief') return <IconBriefs size={18} />;
  if (entityType === 'post') {
    switch (format) {
      case 'carousel':
        return <IconCarousel size={18} />;
      case 'single_image':
        return <IconImage size={18} />;
      case 'video':
        return <IconVideo size={18} />;
      case 'link':
        return <IconLink size={18} />;
      case 'text':
        return <IconText size={18} />;
      default:
        return <IconImage size={18} />;
    }
  }
  return <IconActivity size={18} />;
}

/**
 * A small rounded square tile shown on the right of an activity card. The tone is
 * the same deterministic avatar palette/hash, keyed by the entity id, so a post or
 * brief keeps a stable colour across the feed. Decorative only (aria-hidden); the
 * card body remains the interactive surface.
 */
export function ThumbTile({ toneKey, entityType, format }: ThumbTileProps): ReactElement {
  return (
    <span
      aria-hidden="true"
      style={{ backgroundColor: colorFor(toneKey) }}
      className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-white')}
    >
      {thumbGlyph(entityType, format)}
    </span>
  );
}
