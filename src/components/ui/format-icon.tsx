// One source for a post format's glyph token, its display label, and the icon
// element. The token set is the visual vocabulary of the card meta line and the
// Thumbnail fallback tile; it is narrower than POST_FORMATS (single_image folds
// into 'image') so callers map the DB format to a token before rendering.

import type { ReactElement } from 'react';
import { IconText, IconImage, IconCarousel, IconVideo, IconLink } from '@/components/ui/icons';

export type FormatGlyphToken = 'text' | 'image' | 'carousel' | 'video' | 'link';

export const FORMAT_GLYPH_LABEL: Record<FormatGlyphToken, string> = {
  text: 'Text',
  image: 'Image',
  carousel: 'Carousel',
  video: 'Video',
  link: 'Link',
};

/** The format glyph as an icon element at the given pixel size. */
export function formatIcon(token: FormatGlyphToken, size = 14): ReactElement {
  switch (token) {
    case 'text':
      return <IconText size={size} />;
    case 'image':
      return <IconImage size={size} />;
    case 'carousel':
      return <IconCarousel size={size} />;
    case 'video':
      return <IconVideo size={size} />;
    case 'link':
      return <IconLink size={size} />;
  }
}
