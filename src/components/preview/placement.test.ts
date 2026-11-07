import { describe, expect, it } from 'vitest';
import { POST_FORMATS, POST_PLATFORMS } from '@srtdio/posts';
import {
  PLACEMENT_LABEL,
  defaultPlacement,
  placementFormat,
  placementOptions,
} from '@/components/preview/placement';

describe('placement', () => {
  it('leaves the placement open only for a plain video on Instagram or Facebook', () => {
    for (const platform of POST_PLATFORMS) {
      for (const format of POST_FORMATS) {
        const open = format === 'video' && (platform === 'instagram' || platform === 'facebook');
        expect(placementOptions(platform, format) !== null, `${platform} ${format}`).toBe(open);
      }
    }
    expect(placementOptions('instagram', 'video')?.map((p) => PLACEMENT_LABEL[p])).toEqual([
      'Reel',
      'Story',
      'Feed',
    ]);
  });

  it('opens on the format: reel / short fixed full screen, story the story, else feed', () => {
    expect(defaultPlacement('reel')).toBe('reel');
    expect(defaultPlacement('short')).toBe('reel');
    expect(defaultPlacement('story')).toBe('story');
    for (const format of ['single_image', 'carousel', 'text', 'thread', 'link', 'video']) {
      expect(defaultPlacement(format)).toBe('feed');
    }
  });

  it('draws a picked placement as that format; a fixed format is never changed', () => {
    expect(placementFormat('instagram', 'video', 'reel')).toBe('reel');
    expect(placementFormat('facebook', 'video', 'story')).toBe('story');
    expect(placementFormat('instagram', 'video', 'feed')).toBe('video');
    expect(placementFormat('linkedin', 'video', 'reel')).toBe('video');
    expect(placementFormat('instagram', 'carousel', 'story')).toBe('carousel');
  });
});
