import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ThumbnailResult } from '@/lib/files/thumbnail';
import { attachLateThumbnail } from '@/lib/asset-thumbnail-attach';

// The local thumbnail (the one the sending bubble shows and the upload
// attaches) is controlled here: it may be made, failed or still pending.
const local = vi.hoisted(() => ({
  next: null as Promise<ThumbnailResult> | null,
}));
vi.mock('@/lib/files/thumbnail', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/files/thumbnail')>();
  const made = new WeakMap<File, Promise<ThumbnailResult>>();
  return {
    ...actual,
    sharedThumbnail: (file: File): Promise<ThumbnailResult> => {
      const known = made.get(file);
      if (known !== undefined) return known;
      const promise = local.next ?? Promise.resolve({ ok: false, reason: 'failed' } as const);
      made.set(file, promise);
      return promise;
    },
  };
});

import {
  buildAttachmentMeta,
  PENDING_THUMB_SIZE,
  pickTimeThumbnail,
  thumbnailMetaOf,
  uploadChatAttachment,
  type ChatUploadParams,
} from '@/lib/chat/attachments';

const THUMB_URL = 'https://upload/thumbnail';

function params(file: File, versionId: string, onThumb?: () => void): ChatUploadParams {
  return {
    file,
    workspaceId: 'ws',
    origin: 'chat',
    token: 'tok',
    endpoint: 'https://upload',
    attachThumbnail: attachLateThumbnail,
    fetcher: vi.fn(async (input: string) => {
      if (input === THUMB_URL) {
        onThumb?.();
        return new Response(JSON.stringify({ thumbnail: { width: 580, height: 751 } }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ asset: { assetId: 'a', versionId, reused: false } }), {
        status: 201,
      });
    }),
  };
}

const pdf = (): File => new File(['%PDF'], 'deck.pdf', { type: 'application/pdf' });

beforeEach(() => {
  local.next = null;
});

describe('pickTimeThumbnail', () => {
  it('uses the local thumbnail size and page count once made', () => {
    const made: ThumbnailResult = {
      ok: true,
      blob: new Blob(['x']),
      width: 580,
      height: 820,
      pageCount: 3,
    };
    expect(pickTimeThumbnail('application/pdf', made)).toEqual({
      width: 580,
      height: 820,
      pageCount: 3,
    });
  });

  it('reserves the kind box while the local thumbnail is still being made', () => {
    expect(pickTimeThumbnail('application/pdf', undefined)).toEqual({
      width: PENDING_THUMB_SIZE.pdf.thumbW,
      height: PENDING_THUMB_SIZE.pdf.thumbH,
    });
    expect(pickTimeThumbnail('video/mp4', undefined)).toEqual({
      width: PENDING_THUMB_SIZE.video.thumbW,
      height: PENDING_THUMB_SIZE.video.thumbH,
    });
  });

  it('records no size for a failed thumbnail or a file without one', () => {
    expect(pickTimeThumbnail('application/pdf', { ok: false, reason: 'failed' })).toBe(null);
    expect(pickTimeThumbnail('image/png', undefined)).toBe(null);
    expect(pickTimeThumbnail('audio/webm', undefined)).toBe(null);
  });
});

describe('uploadChatAttachment never waits on the thumbnail', () => {
  it('a thumbnail still being made: resolves at once with the kind box in the meta', async () => {
    // Never resolved: the upload must not wait for it.
    local.next = new Promise<ThumbnailResult>(() => undefined);
    const result = await uploadChatAttachment(params(pdf(), 'v-pending'));
    expect(result).toEqual({
      ok: true,
      reused: false,
      versionId: 'v-pending',
      thumbnail: { width: PENDING_THUMB_SIZE.pdf.thumbW, height: PENDING_THUMB_SIZE.pdf.thumbH },
    });
    const meta = buildAttachmentMeta([
      { assetId: 'v-pending', name: 'deck.pdf', mime: 'application/pdf' },
    ])['v-pending'];
    expect(meta).toMatchObject({
      thumb_w: PENDING_THUMB_SIZE.pdf.thumbW,
      thumb_h: PENDING_THUMB_SIZE.pdf.thumbH,
    });
  });

  it('a thumbnail made at pick time: the meta carries its local size, before it is stored', async () => {
    local.next = Promise.resolve({
      ok: true,
      blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
      width: 580,
      height: 820,
      pageCount: 2,
    });
    let posted = false;
    const result = await uploadChatAttachment(
      params(pdf(), 'v-local', () => {
        posted = true;
      }),
    );
    expect(result).toEqual({
      ok: true,
      reused: false,
      versionId: 'v-local',
      thumbnail: { width: 580, height: 820, pageCount: 2 },
    });
    expect(
      thumbnailMetaOf({ assetId: 'v-local', name: 'deck.pdf', mime: 'application/pdf' }),
    ).toEqual({ thumbW: 580, thumbH: 820, pageCount: 2 });
    // The stored rendition follows in the background; the recorded size never changes.
    await vi.waitFor(() => expect(posted).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      thumbnailMetaOf({ assetId: 'v-local', name: 'deck.pdf', mime: 'application/pdf' }),
    ).toEqual({ thumbW: 580, thumbH: 820, pageCount: 2 });
  });

  it('a failed thumbnail records no size (icon card)', async () => {
    local.next = Promise.resolve({ ok: false, reason: 'failed' });
    const result = await uploadChatAttachment(params(pdf(), 'v-failed'));
    expect(result).toEqual({ ok: true, reused: false, versionId: 'v-failed' });
    expect(
      thumbnailMetaOf({ assetId: 'v-failed', name: 'deck.pdf', mime: 'application/pdf' }),
    ).toBe(null);
  });
});
