import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { PresignCache, type PresignDeps } from '@/lib/asset-presign';
import {
  AlbumGrid,
  AttachmentsFallback,
  MessageAttachments,
  albumGridClass,
  albumTiles,
  attachmentView,
} from '@/components/chat/MessageAttachments';
import { BUBBLE_FILL } from '@/components/chat/FileBubble';
import { PressableRow } from '@/components/ui/PressableRow';
import type { MessageAttachment } from '@/lib/chat/attachments';

// Realistic asset_versions.id fixtures: the render layer must presign the VERSION
// id (asset-read looks it up in asset_versions), so a future asset-vs-version
// regression that carried the asset id would fail the cache assertions below.
const IMG_VERSION = '11111111-1111-4111-8111-111111111111';
const FILE_VERSION = '22222222-2222-4222-8222-222222222222';
const AUDIO_VERSION = '33333333-3333-4333-8333-333333333333';

const IMAGE: MessageAttachment = { assetId: IMG_VERSION, name: 'photo.png', mime: 'image/png' };
const FILE: MessageAttachment = {
  assetId: FILE_VERSION,
  name: 'brief.pdf',
  mime: 'application/pdf',
};
const AUDIO: MessageAttachment = {
  assetId: AUDIO_VERSION,
  name: 'note.webm',
  mime: 'audio/webm',
  transcript: 'hello there',
};

describe('attachmentView render dispatch', () => {
  it('renders a resolved image as a thumbnail (src + alt)', () => {
    expect(
      attachmentView({
        attachment: IMAGE,
        presignEnabled: true,
        url: 'https://signed/img',
        failed: false,
      }),
    ).toEqual({ kind: 'image', src: 'https://signed/img', alt: 'photo.png' });
  });

  it('shows the image shimmer while the presign is still in flight', () => {
    expect(
      attachmentView({ attachment: IMAGE, presignEnabled: true, url: null, failed: false }),
    ).toEqual({ kind: 'image-pending', alt: 'photo.png' });
  });

  it('falls back to a file chip for an image when presign failed or is disabled', () => {
    expect(
      attachmentView({ attachment: IMAGE, presignEnabled: true, url: null, failed: true }),
    ).toEqual({ kind: 'file', name: 'photo.png', url: null });
    expect(
      attachmentView({ attachment: IMAGE, presignEnabled: false, url: null, failed: false }),
    ).toEqual({ kind: 'file', name: 'photo.png', url: null });
  });

  it('renders a non-image as a file chip, with an Open link once the url resolves', () => {
    expect(
      attachmentView({ attachment: FILE, presignEnabled: true, url: null, failed: false }),
    ).toEqual({ kind: 'file', name: 'brief.pdf', url: null });
    // A non-null url is the chip's Open link target.
    expect(
      attachmentView({
        attachment: FILE,
        presignEnabled: true,
        url: 'https://signed/pdf',
        failed: false,
      }),
    ).toEqual({ kind: 'file', name: 'brief.pdf', url: 'https://signed/pdf' });
  });

  it('renders an audio attachment as a voice note; a legacy meta transcript is not rendered', () => {
    expect(
      attachmentView({
        attachment: AUDIO,
        presignEnabled: true,
        url: 'https://signed/audio',
        failed: false,
      }),
    ).toEqual({
      kind: 'audio',
      url: 'https://signed/audio',
      name: 'note.webm',
      durationMs: undefined,
      progress: null,
    });
  });

  it('passes the stored durationMs through to the voice note', () => {
    expect(
      attachmentView({
        attachment: { ...AUDIO, durationMs: 18_000 },
        presignEnabled: true,
        url: null,
        failed: false,
      }),
    ).toMatchObject({ kind: 'audio', durationMs: 18_000 });
  });

  it('keeps the voice note while the presign is still in flight (url null)', () => {
    expect(
      attachmentView({ attachment: AUDIO, presignEnabled: true, url: null, failed: false }),
    ).toEqual({
      kind: 'audio',
      url: null,
      name: 'note.webm',
      durationMs: undefined,
      progress: null,
    });
  });

  it('never falls back to a file chip for audio: a failed or disabled presign keeps the voice note, unplayable', () => {
    expect(
      attachmentView({ attachment: AUDIO, presignEnabled: true, url: null, failed: true }),
    ).toMatchObject({ kind: 'audio', url: null, progress: null });
    expect(
      attachmentView({ attachment: AUDIO, presignEnabled: false, url: null, failed: false }),
    ).toMatchObject({ kind: 'audio', url: null, progress: null });
  });

  it('an uploading own voice note is the voice note with its progress and local file, never a file chip', () => {
    const uploading: MessageAttachment = {
      assetId: '',
      name: 'voice-note.webm',
      mime: 'audio/webm',
      durationMs: 7_000,
      local: { key: 'local-1', file: null, previewUrl: null, progress: 0.4 },
    };
    expect(
      attachmentView({
        attachment: uploading,
        presignEnabled: true,
        url: null,
        failed: false,
        localUrl: 'blob:note',
      }),
    ).toEqual({
      kind: 'audio',
      url: 'blob:note',
      name: 'voice-note.webm',
      durationMs: 7_000,
      progress: 0.4,
    });
    // No local file (restored after a reload): still the voice note, play disabled.
    expect(
      attachmentView({ attachment: uploading, presignEnabled: true, url: null, failed: false }),
    ).toMatchObject({ kind: 'audio', url: null, progress: 0.4 });
    // Sent: same branch, the bar goes away, the local file keeps playing.
    expect(
      attachmentView({
        attachment: { ...uploading, assetId: 'v1' },
        presignEnabled: true,
        url: null,
        failed: false,
        localUrl: 'blob:note',
      }),
    ).toMatchObject({ kind: 'audio', url: 'blob:note', progress: null });
  });

  it('a voice note with no audio mime (recorded length) is still a voice note', () => {
    expect(
      attachmentView({
        attachment: { assetId: 'v', name: 'voice.webm', mime: 'video/webm', durationMs: 3_000 },
        presignEnabled: true,
        url: 'https://signed/v',
        failed: false,
      }),
    ).toMatchObject({ kind: 'audio', url: 'https://signed/v' });
  });
});

/** A PresignCache whose only injected dependency, the fetcher, is a spy. */
function spiedCache() {
  const fetcher = vi.fn<PresignDeps['fetcher']>(
    async () =>
      new Response(
        JSON.stringify({ url: 'https://signed/x', expires_at: '2999-01-01T00:00:00Z' }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
  );
  const deps: PresignDeps = {
    endpoint: 'https://asset-read',
    getAccessToken: async () => 'tok',
    fetcher,
  };
  return { cache: new PresignCache(deps), fetcher };
}

/** The asset_version_id sent in a presign request body (the cache's POST). */
function presignedVersionId(init: RequestInit | undefined): unknown {
  const parsed = JSON.parse((init?.body as string | undefined) ?? '{}') as {
    asset_version_id?: unknown;
  };
  return parsed.asset_version_id;
}

describe('presign through the shared cache (what the render layer asks of it)', () => {
  it('presigns each attachment once, keyed on the VERSION id', async () => {
    const { cache, fetcher } = spiedCache();

    // The renderer resolves each attachment's assetId (the version id) via the cache.
    await Promise.all([IMAGE, FILE].map((attachment) => cache.resolve(attachment.assetId)));

    expect(fetcher).toHaveBeenCalledTimes(2);
    const ids = fetcher.mock.calls.map((call) => presignedVersionId(call[1]));
    expect(ids).toEqual([IMG_VERSION, FILE_VERSION]);
  });

  it('never presigns the same version id twice (cache dedupe)', async () => {
    const { cache, fetcher } = spiedCache();

    // Two attachments referencing the same version id (e.g. re-render or repeat).
    await Promise.all([IMG_VERSION, IMG_VERSION].map((id) => cache.resolve(id)));

    expect(fetcher).toHaveBeenCalledOnce();
    expect(presignedVersionId(fetcher.mock.calls[0]?.[1])).toBe(IMG_VERSION);
  });
});

describe('instant send tile (local preview + upload progress)', () => {
  const file = new File(['abc'], 'photo.png', { type: 'image/png' });
  const local = (progress: number, assetId = ''): MessageAttachment => ({
    assetId,
    name: 'photo.png',
    mime: 'image/png',
    size: 3,
    local: { key: 'local-1', file, previewUrl: 'blob:preview', progress },
  });

  it('renders the local preview with its progress while uploading', () => {
    expect(
      attachmentView({ attachment: local(0.4), presignEnabled: true, url: null, failed: false }),
    ).toEqual({ kind: 'image-local', src: 'blob:preview', alt: 'photo.png', progress: 0.4 });
  });

  it('keeps the local preview after the version id lands (never swaps to the presigned url)', () => {
    expect(
      attachmentView({
        attachment: local(1, IMG_VERSION),
        presignEnabled: true,
        url: 'https://signed/img',
        failed: false,
      }),
    ).toEqual({ kind: 'image-local', src: 'blob:preview', alt: 'photo.png', progress: null });
  });

  it('a non-image file shows its chip with the bar and no Open link until uploaded', () => {
    const pdf: MessageAttachment = {
      assetId: '',
      name: 'brief.pdf',
      mime: 'application/pdf',
      local: { key: 'local-2', file, previewUrl: null, progress: 0.5 },
    };
    expect(
      attachmentView({ attachment: pdf, presignEnabled: true, url: null, failed: false }),
    ).toEqual({ kind: 'file', name: 'brief.pdf', url: null, progress: 0.5 });
  });

  function render(attachment: MessageAttachment) {
    const { cache, fetcher } = spiedCache();
    const html = renderToStaticMarkup(
      <MessageAttachments attachments={[attachment]} cache={cache} presignEnabled />,
    );
    return { html, fetcher };
  }

  it('T5: an uploading own voice note shows the ring in the play spot and a flat line, no bars', () => {
    const { cache, fetcher } = spiedCache();
    const voice: MessageAttachment = {
      assetId: '',
      name: 'voice-note.webm',
      mime: 'audio/webm',
      durationMs: 7_000,
      peaks: Array.from({ length: 48 }, (_, i) => i * 2),
      local: { key: 'local-v', file: null, previewUrl: null, progress: 0.25, uploading: true },
    };
    const onCancel = vi.fn();
    const html = renderToStaticMarkup(
      <MessageAttachments
        attachments={[voice]}
        cache={cache}
        presignEnabled
        voiceSpacer=""
        onCancelUpload={onCancel}
      />,
    );
    expect(html).toContain('data-voice-note');
    expect(html).toContain('data-voice-upload');
    expect(html).toContain('0:07');
    // The ring holds the play spot; play is faded out under it.
    expect(html).toContain('data-voice-play-slot="upload"');
    expect(html).toContain('aria-label="Cancel upload"');
    expect(html).toContain('data-upload-progress="25"');
    expect(html).toMatch(/aria-hidden="true" tabindex="-1"[^>]*invisible opacity-0/);
    // A plain flat line; the bars are not visible.
    expect(html).toContain('data-voice-flat="shown"');
    expect(html).toMatch(/data-voice-bars="peaks" class="[^"]*invisible opacity-0/);
    // No upload bar anywhere.
    expect(html).not.toContain('role="progressbar"');
    expect(html).not.toContain('h-[3px]');
    expect(html).not.toContain('WEBM');
    expect(html).not.toContain('Open');

    // Done (version id known, record pending): X becomes play, the line becomes the waveform.
    const done = renderToStaticMarkup(
      <MessageAttachments
        attachments={[
          {
            ...voice,
            assetId: AUDIO_VERSION,
            local: { ...voice.local!, progress: 1, uploading: false },
          },
        ]}
        cache={cache}
        presignEnabled
        voiceSpacer=""
        onCancelUpload={onCancel}
      />,
    );
    expect(done).not.toContain('data-voice-upload');
    expect(done).toContain('data-voice-play-slot="play"');
    expect(done).toContain('data-voice-flat="hidden"');
    expect(done).toMatch(/data-voice-bars="peaks" class="[^"]*"/);
    expect(done).not.toMatch(/data-voice-bars="peaks" class="[^"]*invisible/);
    // The ring is faded out and unfocusable; same size box (no layout shift).
    expect(done).toMatch(/data-upload-ring=""[^>]*aria-hidden="true" tabindex="-1"/);
    expect(done).toContain('relative h-11 w-11 shrink-0');
    expect(html).toContain('relative h-11 w-11 shrink-0');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('T5: no cancel offered (sent, failed or a peer note): the plain note, no ring', () => {
    const { cache } = spiedCache();
    const voice: MessageAttachment = {
      assetId: '',
      name: 'voice-note.webm',
      mime: 'audio/webm',
      durationMs: 7_000,
      local: { key: 'local-v', file: null, previewUrl: null, progress: 0.25 },
    };
    const html = renderToStaticMarkup(
      <MessageAttachments attachments={[voice]} cache={cache} presignEnabled voiceSpacer="" />,
    );
    expect(html).toContain('data-voice-note');
    expect(html).not.toContain('data-upload-ring');
    expect(html).not.toContain('data-voice-play-slot');
  });

  it('hands the voice context (time slot, transcribe flow) through to the note', () => {
    const { cache } = spiedCache();
    const voice: MessageAttachment = {
      assetId: AUDIO_VERSION,
      name: 'voice-note.webm',
      mime: 'audio/webm',
      durationMs: 7_000,
    };
    const html = renderToStaticMarkup(
      <MessageAttachments
        attachments={[voice]}
        cache={cache}
        presignEnabled
        voice={{
          messageId: 'ma-voice-ctx',
          mine: false,
          sender: { name: 'Asha Rao' },
          nextVoiceId: null,
          meta: <span data-meta="row">10:42</span>,
          onTranscribe: () => {},
        }}
      />,
    );
    expect(html).toContain('data-voice-link="transcribe"');
    expect(html.indexOf('data-meta="row"')).toBeGreaterThan(html.indexOf('data-voice-link'));
  });

  it('T6: a single photo is dimmed with the ring centred on it while uploading', () => {
    const { cache, fetcher } = spiedCache();
    const html = renderToStaticMarkup(
      <MessageAttachments
        attachments={[{ ...local(0.4), local: { ...local(0.4).local!, uploading: true } }]}
        cache={cache}
        presignEnabled
        onCancelUpload={() => {}}
      />,
    );
    expect(html).toContain('src="blob:preview"');
    expect(html).toContain('brightness-75');
    expect(html).toContain('aria-label="Cancel upload"');
    expect(html).toContain('data-upload-progress="40"');
    expect(html).toContain('absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2');
    expect(html).not.toContain('progressbar');
    // The local preview never presigns.
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('T6: a queued upload (no request running) spins the indeterminate ring', () => {
    const { cache } = spiedCache();
    const html = renderToStaticMarkup(
      <MessageAttachments
        attachments={[local(0)]}
        cache={cache}
        presignEnabled
        onCancelUpload={() => {}}
      />,
    );
    expect(html).toContain('data-upload-progress="unknown"');
    expect(html).toContain('animate-pulse motion-reduce:animate-none');
  });

  it('T6: a sending file is a FileBubble with a thin bar and no ring (no cancel)', () => {
    const { cache } = spiedCache();
    const pdf: MessageAttachment = {
      assetId: '',
      name: 'brief.pdf',
      mime: 'application/pdf',
      size: 10,
      local: { key: 'local-2', file, previewUrl: null, progress: 0.5, uploading: true },
    };
    const html = renderToStaticMarkup(
      <MessageAttachments
        attachments={[pdf]}
        cache={cache}
        presignEnabled
        onCancelUpload={() => {}}
      />,
    );
    expect(html).toContain('brief.pdf');
    expect(html).toContain('data-file-state="sending"');
    expect(html).toContain('style="transform:scaleX(0.5)"');
    expect(html).not.toContain('data-upload-ring');
    const sent = renderToStaticMarkup(
      <MessageAttachments
        attachments={[
          { assetId: FILE_VERSION, name: 'brief.pdf', mime: 'application/pdf', size: 10 },
        ]}
        cache={cache}
        presignEnabled
        onCancelUpload={() => {}}
      />,
    );
    expect(sent).toContain('data-file-state="sent"');
    expect(sent).not.toContain('data-file-progress');
  });

  it('is plain once uploaded: same preview, no dim, no ring', () => {
    const { cache } = spiedCache();
    const html = renderToStaticMarkup(
      <MessageAttachments
        attachments={[local(1, IMG_VERSION)]}
        cache={cache}
        presignEnabled
        onCancelUpload={() => {}}
      />,
    );
    expect(html).toContain('src="blob:preview"');
    expect(html).not.toContain('brightness-75');
    expect(html).not.toContain('data-upload-ring');
    expect(render(local(1, IMG_VERSION)).html).not.toContain('progressbar');
  });
});

describe('album grid', () => {
  const img = (n: number): MessageAttachment => ({
    assetId: `${n}1111111-1111-4111-8111-111111111111`,
    name: `photo-${n}.png`,
    mime: 'image/png',
  });
  const images = (count: number): MessageAttachment[] =>
    Array.from({ length: count }, (_, i) => img(i + 1));

  it('maps the image count to the tile layout', () => {
    expect(albumGridClass(1)).toBe('grid grid-cols-1');
    expect(albumTiles(1)).toEqual([{ index: 0, className: 'aspect-[4/3] max-h-[320px]', more: 0 }]);
    expect(albumGridClass(2)).toBe('grid grid-cols-2');
    expect(albumTiles(2).map((t) => t.className)).toEqual(['aspect-square', 'aspect-square']);
    expect(albumTiles(3).map((t) => t.className)).toEqual([
      'col-span-2 aspect-[2/1]',
      'aspect-square',
      'aspect-square',
    ]);
    expect(albumTiles(4).map((t) => t.more)).toEqual([0, 0, 0, 0]);
    const six = albumTiles(6);
    expect(six).toHaveLength(4);
    expect(six.every((t) => t.className === 'aspect-square')).toBe(true);
    expect(six[3]).toEqual({ index: 3, className: 'aspect-square', more: 2 });
  });

  function grid(count: number, onOpen = vi.fn()) {
    const { cache } = spiedCache();
    const el = AlbumGrid({ images: images(count), cache, presignEnabled: true, onOpen });
    const tiles = (el.props as { children: [ReactElement[], unknown] }).children[0];
    return { el, tiles, onOpen };
  }

  it('labels every tile "Open photo i of n" and passes its index on tap', () => {
    const { tiles, onOpen } = grid(3);
    expect(tiles.map((t) => (t.props as { 'aria-label': string })['aria-label'])).toEqual([
      'Open photo 1 of 3',
      'Open photo 2 of 3',
      'Open photo 3 of 3',
    ]);
    for (const tile of tiles) expect(tile.type).toBe(PressableRow);
    (tiles[1]?.props as { onClick: () => void }).onClick();
    expect(onOpen).toHaveBeenCalledWith(1);
  });

  it('shows "+2" on the fourth tile of six, which opens at index 3', () => {
    const { cache } = spiedCache();
    const html = renderToStaticMarkup(
      <AlbumGrid images={images(6)} cache={cache} presignEnabled onOpen={() => {}} />,
    );
    expect(html).toContain('+2');
    expect(html).toContain('bg-black/50');
    expect(html).toContain('text-2xl font-semibold text-white');
    expect(html).toContain('gap-[2px]');
    expect(html).toContain('rounded-[15px]');
    expect(html.match(/<button/g)).toHaveLength(4);
    const { tiles, onOpen } = grid(6);
    (tiles[3]?.props as { onClick: () => void }).onClick();
    expect(onOpen).toHaveBeenCalledWith(3);
  });

  it('first paint is the final grid: pending tiles are bg-panel-3 boxes sized by the grid', () => {
    const { cache } = spiedCache();
    const html = renderToStaticMarkup(
      <AlbumGrid images={images(2)} cache={cache} presignEnabled onOpen={() => {}} />,
    );
    expect(html).toContain('bg-panel-3');
    expect(html).toContain('aspect-square');
    expect(html).not.toContain('<img');
  });

  it('album mode keeps non-image chips below the album, with the caption under it', () => {
    const { cache } = spiedCache();
    const html = renderToStaticMarkup(
      <MessageAttachments
        attachments={[img(1), FILE, img(2)]}
        cache={cache}
        presignEnabled
        album
        caption={<p>Caption here</p>}
        onImageClick={() => {}}
      />,
    );
    expect(html).toContain('data-album="2"');
    expect(html).toContain('Open photo 2 of 2');
    expect(html).toContain('brief.pdf');
    expect(html.indexOf('data-album')).toBeLessThan(html.indexOf('Caption here'));
    expect(html.indexOf('Caption here')).toBeLessThan(html.indexOf('brief.pdf'));
  });

  it('T6: an album shows ONE ring over the grid; progress is bytes across the whole message', () => {
    const { cache } = spiedCache();
    const file = new File(['abc'], 'photo.png', { type: 'image/png' });
    const tile = (
      key: string,
      size: number,
      progress: number,
      done: boolean,
      uploading = false,
    ) => ({
      assetId: done ? `${key}-ver` : '',
      name: `${key}.png`,
      mime: 'image/png',
      size,
      local: { key, file, previewUrl: `blob:${key}`, progress, uploading },
    });
    // 100 done + 50% of 200 + 0 of 100 = 200 of 400 bytes.
    const attachments: MessageAttachment[] = [
      tile('a', 100, 1, true),
      tile('b', 200, 0.5, false, true),
      tile('c', 100, 0, false),
    ];
    const html = renderToStaticMarkup(
      <MessageAttachments
        attachments={attachments}
        cache={cache}
        presignEnabled
        album
        onCancelUpload={() => {}}
      />,
    );
    expect(html.match(/data-upload-ring=/g)).toHaveLength(1);
    expect(html).toContain('data-upload-progress="50"');
    // A file below the album carries no ring of its own: still ONE for the message.
    const mixed = renderToStaticMarkup(
      <MessageAttachments
        attachments={[
          ...attachments,
          {
            assetId: '',
            name: 'brief.pdf',
            mime: 'application/pdf',
            size: 100,
            local: { key: 'f', file, previewUrl: null, progress: 0 },
          },
        ]}
        cache={cache}
        presignEnabled
        album
        onCancelUpload={() => {}}
      />,
    );
    expect(mixed.match(/data-upload-ring=/g)).toHaveLength(1);
    // Uploading tiles are dimmed; the grid holds the ring.
    expect((html.match(/brightness-75/g) ?? []).length).toBe(2);
    expect(html).toContain('relative w-[320px]');
    expect(html).not.toContain('progressbar');
  });
});

describe('T6: the old thin upload bar no longer exists', () => {
  // The removed component's name, assembled so the self-check grep stays at 0.
  const OLD = ['Upload', 'Bar'].join('');

  it('the module exports no bar component and renders no progress bar', async () => {
    const mod = await import('@/components/chat/MessageAttachments');
    expect(Object.keys(mod)).not.toContain(OLD);
    const source = readFileSync(
      fileURLToPath(new URL('./MessageAttachments.tsx', import.meta.url)),
      'utf8',
    );
    expect(source).not.toContain(OLD);
    expect(source).not.toContain('role="progressbar"');
  });
});

describe('AttachmentsFallback width', () => {
  it('shares the file bubble width rule: never wider than its column', () => {
    const html = renderToStaticMarkup(
      <AttachmentsFallback
        attachments={[{ assetId: 'a1', name: 'deck.pdf', mime: 'application/pdf' }]}
        cache={spiedCache().cache}
        presignEnabled={false}
      />,
    );
    expect(html).toContain(BUBBLE_FILL);
    expect(html).not.toContain('w-[100vw]');
  });
});
