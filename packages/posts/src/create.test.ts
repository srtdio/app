import { describe, expect, it } from 'vitest';
import {
  FORMATS_BY_PLATFORM,
  PLATFORM_LABELS,
  POST_FORMATS,
  POST_PLATFORMS,
  PostCreatePayloadSchema,
  formatLabel,
  platformLabel,
  toPostPlatform,
} from './create';

describe('platform constants', () => {
  it('lists the seven platforms in picker order', () => {
    expect(POST_PLATFORMS).toEqual([
      'instagram',
      'x',
      'threads',
      'linkedin',
      'facebook',
      'tiktok',
      'youtube_shorts',
    ]);
  });

  it('lists the nine formats', () => {
    expect(POST_FORMATS).toEqual([
      'text',
      'single_image',
      'carousel',
      'video',
      'link',
      'reel',
      'story',
      'thread',
      'short',
    ]);
  });

  it('maps every platform to exactly the formats post_create accepts', () => {
    expect(FORMATS_BY_PLATFORM).toEqual({
      instagram: ['reel', 'story', 'carousel', 'single_image'],
      x: ['text', 'single_image', 'video', 'thread'],
      threads: ['text', 'single_image', 'carousel', 'video'],
      linkedin: ['text', 'single_image', 'carousel', 'video', 'link'],
      facebook: ['text', 'single_image', 'carousel', 'video', 'reel', 'story', 'link'],
      tiktok: ['video'],
      youtube_shorts: ['short'],
    });
    for (const formats of Object.values(FORMATS_BY_PLATFORM)) {
      for (const format of formats) expect(POST_FORMATS).toContain(format);
    }
  });

  it('labels every platform', () => {
    expect(PLATFORM_LABELS).toEqual({
      instagram: 'Instagram',
      x: 'X',
      threads: 'Threads',
      linkedin: 'LinkedIn',
      facebook: 'Facebook',
      tiktok: 'TikTok',
      youtube_shorts: 'YouTube Shorts',
    });
    expect(platformLabel('youtube_shorts')).toBe('YouTube Shorts');
  });

  it('throws on an unknown platform instead of rendering a blank label', () => {
    expect(() => toPostPlatform('myspace')).toThrow('unknown platform: myspace');
    expect(() => platformLabel('')).toThrow();
    expect(() => formatLabel('myspace', 'text')).toThrow();
  });
});

describe('formatLabel', () => {
  it('reads single_image as "Image" on X and Threads', () => {
    expect(formatLabel('x', 'single_image')).toBe('Image');
    expect(formatLabel('threads', 'single_image')).toBe('Image');
  });

  it('reads single_image as "Single image" elsewhere', () => {
    for (const platform of ['instagram', 'linkedin', 'facebook']) {
      expect(formatLabel(platform, 'single_image')).toBe('Single image');
    }
  });

  it('title cases the other formats', () => {
    expect(formatLabel('instagram', 'reel')).toBe('Reel');
    expect(formatLabel('facebook', 'story')).toBe('Story');
    expect(formatLabel('x', 'thread')).toBe('Thread');
    expect(formatLabel('youtube_shorts', 'short')).toBe('Short');
    expect(formatLabel('linkedin', 'link')).toBe('Link');
    expect(formatLabel('linkedin', 'text')).toBe('Text');
    expect(formatLabel('tiktok', 'video')).toBe('Video');
    expect(formatLabel('threads', 'carousel')).toBe('Carousel');
  });

  it('throws on an unknown format', () => {
    expect(() => formatLabel('x', 'gif')).toThrow('unknown format: gif');
  });
});

describe('PostCreatePayloadSchema', () => {
  it('accepts a payload without a platform (post_create takes the workspace one)', () => {
    expect(PostCreatePayloadSchema.safeParse({ title: 'T' }).success).toBe(true);
  });

  it('accepts every new format', () => {
    for (const format of POST_FORMATS) {
      expect(PostCreatePayloadSchema.safeParse({ title: 'T', format }).success).toBe(true);
    }
  });
});
