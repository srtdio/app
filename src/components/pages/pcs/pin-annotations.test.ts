import { describe, expect, it } from 'vitest';
import {
  buildPinData,
  checkpointMarks,
  pinLabel,
  pinMark,
  pinName,
  withFreshMarks,
  type CheckpointMark,
} from '@/components/pages/pcs/pin-annotations';
import type { GalleryItem, PostAnnotation, PostVersion } from '@srtdio/posts';

// Pins are numbered like checkpoints (a pin on a checkpoint shows its
// ledger_seq; an agency pin is an ink dot with no number), carry the slide they
// sit on for "On photo {n}", and stale pins stay out of the live overlay.
// Exercised on the pure helper so no page mount is needed.

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

const NO_MARKS: ReadonlyMap<string, CheckpointMark> = new Map();

function marks(entries: Record<string, CheckpointMark>): ReadonlyMap<string, CheckpointMark> {
  return new Map(Object.entries(entries));
}

const OPEN = (seq: number): CheckpointMark => ({ seq, resolved_at: null, accepted_at: null });

describe('buildPinData', () => {
  it('a pin on a checkpoint shows its ledger_seq; a pin on a plain comment is an ink dot', () => {
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
      marks({ 'c-a': OPEN(7) }),
    );
    expect(result.pinsByAttachment['aa-1']?.[0]).toMatchObject({ n: 7, state: 'open' });
    expect(result.pinsByAttachment['aa-2']?.[0]).toMatchObject({ n: null, state: 'pin' });
    expect(result.pinChipsByCommentId['c-a']?.n).toBe(7);
  });

  it('"On photo {n}" data: a current pin carries its 1-based slide', () => {
    const result = buildPinData(
      [
        pin({ id: 'a', comment_id: 'c-a', asset_attachment_id: 'aa-1' }),
        pin({ id: 'b', comment_id: 'c-b', asset_attachment_id: 'aa-2' }),
      ],
      V2,
      versions,
      gallery,
      marks({ 'c-a': OPEN(1) }),
    );
    expect(result.pinChipsByCommentId['c-a']).toEqual({
      n: 1,
      quote: 'Pin on a.png',
      stale: false,
      versionNumber: 2,
      slide: 1,
    });
    expect(result.pinChipsByCommentId['c-b']?.slide).toBe(2);
  });

  it('resolved pins go good like the list: outline until confirmed, then filled', () => {
    const result = buildPinData(
      [
        pin({ id: 'a', comment_id: 'c-a', created_at: '2026-01-01T00:00:00Z' }),
        pin({ id: 'b', comment_id: 'c-b', created_at: '2026-01-02T00:00:00Z' }),
      ],
      V2,
      versions,
      gallery,
      marks({
        'c-a': { seq: 2, resolved_at: '2026-01-03T00:00:00Z', accepted_at: null },
        'c-b': { seq: 3, resolved_at: '2026-01-03T00:00:00Z', accepted_at: '2026-01-04T00:00:00Z' },
      }),
    );
    expect(result.pinsByAttachment['aa-1']?.map((d) => d.state)).toEqual([
      'resolved',
      'confirmed',
    ]);
  });

  it('excludes stale pins from the live overlay, surfacing only a greyed chip', () => {
    const result = buildPinData(
      [pin({ id: 'old', comment_id: 'c-old', post_version_id: V1 })],
      V2,
      versions,
      gallery,
      marks({ 'c-old': OPEN(4) }),
    );
    expect(result.pinsByAttachment['aa-1']).toBeUndefined();
    expect(result.pinChipsByCommentId['c-old']).toEqual({
      n: 0,
      quote: 'Pin on a.png',
      stale: true,
      versionNumber: 1,
    });
  });

  it('skips an out-of-range pin from the overlay without throwing, keeping its chip', () => {
    const result = buildPinData(
      [pin({ id: 'oob', comment_id: 'c-oob', image_x: 1.4, image_y: 0.5 })],
      V2,
      versions,
      gallery,
      marks({ 'c-oob': OPEN(2) }),
    );
    expect(result.pinsByAttachment['aa-1']).toBeUndefined();
    expect(result.pinChipsByCommentId['c-oob']?.n).toBe(2);
  });

  it('an unmatched slide gives no slide (no tile draws its dot)', () => {
    const result = buildPinData(
      [pin({ id: 'x', comment_id: 'c-x', asset_attachment_id: 'aa-gone' })],
      V2,
      versions,
      gallery,
      NO_MARKS,
    );
    expect(result.pinChipsByCommentId['c-x']?.slide).toBeUndefined();
    expect(result.pinsByAttachment['aa-gone']).toHaveLength(1);
  });

  it('labels a pin by its matched slide filename', () => {
    expect(pinLabel('a.png')).toBe('Pin on a.png');
    expect(pinLabel(undefined)).toBe('Pin on image');
    expect(pinLabel('')).toBe('Pin on image');
  });
});

describe('pin marks', () => {
  it('indexes only checkpoints (ledger_seq set) by comment id', () => {
    const map = checkpointMarks([
      { id: 'c1', ledger_seq: 1, resolved_at: null, accepted_at: null },
      { id: 'c2', ledger_seq: null, resolved_at: null, accepted_at: null },
    ]);
    expect([...map.keys()]).toEqual(['c1']);
    expect(checkpointMarks(null).size).toBe(0);
  });

  it('a fresh number fills in until the read carries the row; the read wins', () => {
    const read = marks({ c1: { seq: 1, resolved_at: 'x', accepted_at: null } });
    const merged = withFreshMarks(read, { c1: OPEN(9), c2: OPEN(2) });
    expect(merged.get('c1')?.seq).toBe(1);
    expect(merged.get('c2')?.seq).toBe(2);
    expect(withFreshMarks(read, {})).toBe(read);
  });

  it('pinMark and pinName: numbered checkpoint vs agency dot', () => {
    expect(pinMark(OPEN(5))).toEqual({ n: 5, state: 'open' });
    expect(pinMark(undefined)).toEqual({ n: null, state: 'pin' });
    expect(pinName({ n: 5 })).toBe('Pin 5');
    expect(pinName({ n: null })).toBe('Pin');
  });
});
