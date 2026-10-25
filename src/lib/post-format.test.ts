import { describe, expect, it } from 'vitest';
import { formatLabel } from '@srtdio/posts';
import { POST_FORMAT_LABELS, postFormatLabel } from './post-format';

describe('postFormatLabel', () => {
  it('matches the create-sheet label for a known platform', () => {
    expect(postFormatLabel('single_image', 'x')).toBe(formatLabel('x', 'single_image'));
    expect(postFormatLabel('single_image', 'instagram')).toBe('Single image');
    expect(postFormatLabel('reel', 'instagram')).toBe('Reel');
  });
  it('reads the neutral label without a platform', () => {
    expect(postFormatLabel('single_image')).toBe('Single image');
    expect(postFormatLabel('carousel', null)).toBe('Carousel');
    expect(postFormatLabel('short', 'myspace')).toBe('Short');
  });
  it('sentence-cases an unknown format instead of throwing', () => {
    expect(postFormatLabel('photo_grid')).toBe('Photo grid');
  });
  it('maps every known format', () => {
    expect(POST_FORMAT_LABELS).toEqual({
      text: 'Text',
      single_image: 'Single image',
      carousel: 'Carousel',
      video: 'Video',
      link: 'Link',
      reel: 'Reel',
      story: 'Story',
      thread: 'Thread',
      short: 'Short',
    });
  });
});
