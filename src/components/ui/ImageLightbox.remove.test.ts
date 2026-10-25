// The photo viewer's bin (chat only): it shows left of Download only for an
// image that carries onRemove, reads "Remove photo" (or the caller's label,
// e.g. "Remove video"), and after a tap shows the next image, or closes on
// the last one. Viewers outside chat pass no onRemove and get no bin.
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { indexAfterRemove, REMOVE_IMAGE_LABEL } from '@/components/ui/ImageLightbox';
import { withRemovableImages } from '@/components/chat/MessageThread';
import { REMOVE_PHOTO_ARIA, REMOVE_VIDEO_ARIA, removeMediaAria } from '@/lib/chat/remove-files';
import type { ThreadMessage } from '@/lib/chat/thread';

const source = readFileSync(fileURLToPath(new URL('./ImageLightbox.tsx', import.meta.url)), 'utf8');

const AT = '2026-10-25T10:00:00.000Z';

function msg(over: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id: 'm1',
    senderUserId: 'me',
    body: '',
    createdAt: AT,
    time: Date.parse(AT),
    provisionalTime: false,
    mine: true,
    attachments: [
      { assetId: 'a1', name: '1.jpg', mime: 'image/jpeg' },
      { assetId: 'a2', name: '2.jpg', mime: 'image/jpeg' },
    ],
    sharedPostIds: [],
    sharedBriefIds: [],
    reply: null,
    state: 'sent',
    status: 'sent',
    reactions: [],
    ...over,
  };
}

const DATA = {
  images: [
    { assetId: 'a1', name: '1.jpg' },
    { assetId: 'a2', name: '2.jpg' },
  ],
  details: { sender: 'You', time: '10:00' },
};

describe('indexAfterRemove', () => {
  it('the same index shows the next image', () => {
    expect(indexAfterRemove(0, 3)).toBe(0);
    expect(indexAfterRemove(1, 3)).toBe(1);
  });

  it('removing the last image of several wraps to the first', () => {
    expect(indexAfterRemove(2, 3)).toBe(0);
  });

  it('removing the only image closes the viewer', () => {
    expect(indexAfterRemove(0, 1)).toBeNull();
  });
});

describe('ImageLightbox bin', () => {
  it('renders only for an image with onRemove, left of Download, labelled "Remove photo" by default', () => {
    expect(REMOVE_IMAGE_LABEL).toBe('Remove photo');
    expect(source).toContain('current.onRemove !== undefined ? (');
    expect(source).toContain('aria-label={current.removeLabel ?? REMOVE_IMAGE_LABEL}');
    expect(source.indexOf('<IconTrash')).toBeLessThan(source.indexOf('<DownloadControl'));
  });

  it('a tap removes, then closes on the last image or moves on', () => {
    expect(source).toContain('const next = indexAfterRemove(index, count);');
    expect(source).toContain('if (next === null) onClose();');
  });
});

describe('withRemovableImages (chat)', () => {
  it('no handler: the viewer is unchanged (no bin)', () => {
    expect(withRemovableImages(DATA, msg(), undefined, 'me', new Set())).toBe(DATA);
  });

  it('own, unmarked images get the bin with "Remove photo"; a tap removes just that file', () => {
    const onRemove = vi.fn();
    const out = withRemovableImages(DATA, msg(), onRemove, 'me', new Set());
    expect(out.images.map((i) => i.removeLabel)).toEqual([REMOVE_PHOTO_ARIA, REMOVE_PHOTO_ARIA]);
    out.images[1]?.onRemove?.();
    expect(onRemove).toHaveBeenCalledWith([{ messageId: 'm1', assetId: 'a2', mime: 'image/jpeg' }]);
  });

  it("no bin on someone else's or a marked message", () => {
    const peer = withRemovableImages(
      DATA,
      msg({ senderUserId: 'peer', mine: false }),
      vi.fn(),
      'me',
      new Set(),
    );
    expect(peer.images.every((i) => i.onRemove === undefined)).toBe(true);
    const marked = withRemovableImages(DATA, msg(), vi.fn(), 'me', new Set(['m1']));
    expect(marked.images.every((i) => i.onRemove === undefined)).toBe(true);
  });

  it('the label reads "Remove video" for a video', () => {
    expect(removeMediaAria('image/png')).toBe('Remove photo');
    expect(removeMediaAria('video/mp4')).toBe(REMOVE_VIDEO_ARIA);
    expect(REMOVE_VIDEO_ARIA).toBe('Remove video');
  });
});
