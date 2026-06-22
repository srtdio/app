import { describe, expect, it } from 'vitest';
import { commentImageNav } from '@/components/comments/CommentImageLightbox';
import type { MessageAttachment } from '@/lib/chat/attachments';

// commentImageNav is the only DOM-free logic in the lightbox: it filters a
// comment's attachments to its images and remaps the clicked id to its index
// among them. These cover the image-only, mixed, missing-id, and all-files cases.

function image(assetId: string): MessageAttachment {
  return { assetId, name: assetId, mime: 'image/png' };
}

function file(assetId: string): MessageAttachment {
  return { assetId, name: assetId, mime: 'application/pdf' };
}

describe('commentImageNav', () => {
  it('returns every image with the clicked index for an images-only list', () => {
    const attachments = [image('a'), image('b'), image('c')];
    const nav = commentImageNav(attachments, 'b');
    expect(nav.images.map((a) => a.assetId)).toEqual(['a', 'b', 'c']);
    expect(nav.index).toBe(1);
  });

  it('drops files and remaps the clicked index among the remaining images', () => {
    const attachments = [file('f1'), image('a'), file('f2'), image('b')];
    const nav = commentImageNav(attachments, 'b');
    expect(nav.images.map((a) => a.assetId)).toEqual(['a', 'b']);
    expect(nav.index).toBe(1);
  });

  it('falls back to index 0 when the clicked id is absent but images exist', () => {
    const attachments = [image('a'), image('b')];
    const nav = commentImageNav(attachments, 'missing');
    expect(nav.images.map((a) => a.assetId)).toEqual(['a', 'b']);
    expect(nav.index).toBe(0);
  });

  it('returns an empty image list for an all-files comment', () => {
    const attachments = [file('f1'), file('f2')];
    const nav = commentImageNav(attachments, 'f1');
    expect(nav.images).toEqual([]);
    expect(nav.index).toBe(0);
  });
});
