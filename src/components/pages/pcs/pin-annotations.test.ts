import { describe, expect, it } from 'vitest';
import { buildPinData, pinLabel } from '@/components/pages/pcs/pin-annotations';
import type { GalleryItem, PostAnnotation, PostVersion } from '@srtdio/posts';

// Pin numbering continues F4's caption sequence and stale pins stay out of the
// live overlay. Exercised on the pure helper so no page mount is needed.

const V1 = 'ver-1';
const V2 = 'ver-2';

const versions: PostVersion[] = [
  { id: V1, version_number: 1 } as PostVersion,
  { id: V2, version_number: 2 } as PostVersion,
];

const gallery: GalleryItem[] = [
  { assetAttachmentId: 'aa-1', filename: 'a.png' } as GalleryItem,
  { assetAttachmentId: 'aa-2', filename: 'b.png' } as GalleryItem,
];

function pin(over: Partial<PostAnnotation>): PostAnnotation {
  return {
    id: 'an',
    kind: 'image_pin',
    post_id: 'p',
    post_version_id: V2,
    comment_id: 'c',
    asset_attachment_id: 'aa-1',
    image_x: 0.5,
    image_y: 0.5,
    caption_start: null,
    caption_end: null,
    workspace_id: 'w',
    created_at: '2026-01-01T00:00:00Z',
    ...over,
  } as PostAnnotation;
}

describe('buildPinData', () => {
  it('numbers current-version pins after the captions (startN)', () => {
    const result = buildPinData(
      [
        pin({
          id: 'a',
          comment_id: 'c-a',
          asset_attachment_id: 'aa-1',
          created_at: '2026-01-01T00:00:00Z',
        }),
        pin({
          id: 'b',
          comment_id: 'c-b',
          asset_attachment_id: 'aa-2',
          created_at: '2026-01-02T00:00:00Z',
        }),
      ],
      V2,
      versions,
      gallery,
      2, // two caption highlights already numbered 1 and 2
    );
    expect(result.pinChipsByCommentId['c-a']?.n).toBe(3);
    expect(result.pinChipsByCommentId['c-b']?.n).toBe(4);
    expect(result.nextN).toBe(4);
    expect(result.pinsByAttachment['aa-1']?.[0]?.n).toBe(3);
    expect(result.pinsByAttachment['aa-2']?.[0]?.n).toBe(4);
  });

  it('excludes stale pins from the live overlay, surfacing only a greyed chip', () => {
    const result = buildPinData(
      [pin({ id: 'old', comment_id: 'c-old', post_version_id: V1 })],
      V2,
      versions,
      gallery,
      0,
    );
    expect(result.pinsByAttachment['aa-1']).toBeUndefined();
    expect(result.pinChipsByCommentId['c-old']).toEqual({
      n: 0,
      quote: 'Pin on a.png',
      stale: true,
      versionNumber: 1,
    });
    expect(result.nextN).toBe(0);
  });

  it('skips an out-of-range pin from the overlay without throwing', () => {
    const result = buildPinData(
      [pin({ id: 'oob', comment_id: 'c-oob', image_x: 1.4, image_y: 0.5 })],
      V2,
      versions,
      gallery,
      1,
    );
    expect(result.pinsByAttachment['aa-1']).toBeUndefined();
    // It still consumes a chip number as a current-version pin.
    expect(result.pinChipsByCommentId['c-oob']?.n).toBe(2);
  });

  it('labels a pin by its matched slide filename', () => {
    expect(pinLabel('a.png')).toBe('Pin on a.png');
    expect(pinLabel(undefined)).toBe('Pin on image');
    expect(pinLabel('')).toBe('Pin on image');
  });
});
