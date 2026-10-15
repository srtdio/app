import { describe, expect, it } from 'vitest';
import {
  expectedKinds,
  fileKindOf,
  filePrompt,
  isMismatch,
  mismatchedFiles,
} from '@/components/pages/create/file-kind';

describe('fileKindOf', () => {
  it('maps MIME types', () => {
    expect(fileKindOf('image/png')).toBe('image');
    expect(fileKindOf('video/mp4')).toBe('video');
    expect(fileKindOf('application/pdf')).toBe('document');
    expect(fileKindOf('application/zip')).toBe('other');
  });
});

describe('expected kinds', () => {
  it('video-only formats expect video', () => {
    for (const f of ['reel', 'video', 'short'])
      expect(expectedKinds('instagram', f)).toEqual(['video']);
    expect(expectedKinds('youtube_shorts', 'short')).toEqual(['video']);
  });
  it('single image expects images; story and carousel take either', () => {
    expect(expectedKinds('x', 'single_image')).toEqual(['image']);
    expect(expectedKinds('instagram', 'story')).toEqual(['image', 'video']);
    expect(expectedKinds('instagram', 'carousel')).toEqual(['image', 'video']);
  });
  it('linkedin carousel takes a PDF or images', () => {
    expect(expectedKinds('linkedin', 'carousel')).toEqual(['document', 'image']);
    expect(isMismatch('linkedin', 'carousel', 'document')).toBe(false);
    expect(isMismatch('linkedin', 'carousel', 'video')).toBe(true);
  });
  it('text and link take no file; thread has no expectation', () => {
    expect(expectedKinds('x', 'text')).toEqual([]);
    expect(expectedKinds('linkedin', 'link')).toEqual([]);
    expect(expectedKinds('x', 'thread')).toBeNull();
    expect(isMismatch('x', 'thread', 'video')).toBe(false);
  });
});

describe('filePrompt', () => {
  it('is null when every file matches', () => {
    expect(filePrompt('instagram', 'reel', ['video'])).toBeNull();
    expect(filePrompt('instagram', 'reel', [])).toBeNull();
  });
  it('adapts copy to the case', () => {
    expect(filePrompt('instagram', 'reel', ['image'])).toEqual({
      question: 'This format usually has a video. Go with an image?',
      keepLabel: 'Yes, keep',
      removeLabel: 'No, remove it',
    });
    expect(filePrompt('x', 'single_image', ['video'])?.question).toBe(
      'This format usually has an image. Go with a video?',
    );
    expect(filePrompt('instagram', 'story', ['document'])?.question).toBe(
      'This format usually has an image or video. Go with a PDF?',
    );
    expect(filePrompt('linkedin', 'carousel', ['video'])?.question).toBe(
      'This format usually has a PDF or images. Go with a video?',
    );
    expect(filePrompt('x', 'text', ['image'])?.question).toBe(
      'This format usually has no file. Go with an image?',
    );
  });
  it('counts several files', () => {
    const two = filePrompt('instagram', 'reel', ['image', 'image']);
    expect(two?.question).toBe('This format usually has a video. Go with 2 images?');
    expect(two?.removeLabel).toBe('No, remove them');
    expect(filePrompt('instagram', 'reel', ['image', 'document'])?.question).toBe(
      'This format usually has a video. Go with 2 files?',
    );
  });
});

describe('mismatchedFiles', () => {
  it('skips links and files without a MIME type', () => {
    const items = [
      { versionId: 'a', kind: 'image', mime: 'image/png' },
      { versionId: 'b', kind: 'file', mime: 'video/mp4' },
      { versionId: 'c', kind: 'link' },
      { versionId: 'd', kind: 'file' },
    ];
    expect(mismatchedFiles('instagram', 'reel', items).map((i) => i.versionId)).toEqual(['a']);
    expect(mismatchedFiles('x', 'single_image', items).map((i) => i.versionId)).toEqual(['b']);
  });
});
