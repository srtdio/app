import { describe, expect, it } from 'vitest';
import { draftPreview } from '@/components/pages/CreatePostSheet';
import type { AttachmentItem } from '@/components/pages/create/AttachmentsField';

const photo = (id: string): AttachmentItem => ({
  versionId: id,
  kind: 'image',
  name: `${id}.jpg`,
  previewUrl: `blob:${id}`,
  mime: 'image/jpeg',
});

describe('draftPreview slides (create sheet carousel)', () => {
  it('passes every photo or video in order, each with its local URL; files are left out', () => {
    const file: AttachmentItem = {
      versionId: 'doc',
      kind: 'file',
      name: 'brief.pdf',
      mime: 'application/pdf',
    };
    const preview = draftPreview({
      platform: 'instagram',
      format: 'carousel',
      caption: 'Hello',
      handle: 'Acme',
      attachments: [photo('a'), file, photo('b')],
    });
    expect(preview?.firstMedia?.assetVersionId).toBe('a');
    expect(preview?.localUrl).toBe('blob:a');
    expect(preview?.slides?.map((slide) => slide.item.assetVersionId)).toEqual(['a', 'b']);
    expect(preview?.slides?.map((slide) => slide.localUrl)).toEqual(['blob:a', 'blob:b']);
  });

  it('no media: no first media and no slides', () => {
    const preview = draftPreview({
      platform: 'linkedin',
      format: 'text',
      caption: 'Words only',
      handle: 'Acme',
      attachments: [],
    });
    expect(preview?.firstMedia).toBeNull();
    expect(preview?.slides).toEqual([]);
  });
});
