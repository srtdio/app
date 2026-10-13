import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { UPLOAD_RING_SIZES, UPLOAD_RING_X, UploadRing } from '@/components/chat/UploadRing';
import { MessageAttachments } from '@/components/chat/MessageAttachments';
import { PresignCache, type PresignDeps } from '@/lib/asset-presign';
import type { MessageAttachment } from '@/lib/chat/attachments';

// T5: the ring never positions itself; each caller places it, at the
// prototype's size. T6: the five upload states, pinned in light and dark
// (token-only markup, so the two themes render the same classes).

function cache(): PresignCache {
  const deps: PresignDeps = {
    endpoint: 'https://asset-read',
    getAccessToken: async () => 'tok',
    fetcher: vi.fn<PresignDeps['fetcher']>(
      async () =>
        new Response(
          JSON.stringify({ url: 'https://signed/x', expires_at: '2999-01-01T00:00:00Z' }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
    ),
  };
  return new PresignCache(deps);
}

const file = new File(['abc'], 'x.bin');
const PEAKS = Array.from({ length: 48 }, (_, i) => (i * 7) % 101);

const voiceUploading: MessageAttachment = {
  assetId: '',
  name: 'voice-note.m4a',
  mime: 'audio/mp4',
  durationMs: 4_000,
  local: { key: 'local-v', file, previewUrl: null, progress: 0.3, uploading: true },
};
const voiceDone: MessageAttachment = {
  ...voiceUploading,
  assetId: '33333333-3333-4333-8333-333333333333',
  peaks: PEAKS,
  local: { key: 'local-v', file, previewUrl: null, progress: 1, uploading: false },
};
const photoUploading: MessageAttachment = {
  assetId: '',
  name: 'photo.png',
  mime: 'image/png',
  size: 3,
  local: { key: 'local-p', file, previewUrl: 'blob:p', progress: 0.4, uploading: true },
};
const album: MessageAttachment[] = ['a', 'b', 'c'].map((key) => ({
  assetId: '',
  name: `${key}.png`,
  mime: 'image/png',
  size: 3,
  local: { key: `local-${key}`, file, previewUrl: `blob:${key}`, progress: 0.5, uploading: true },
}));
const fileUploading: MessageAttachment = {
  assetId: '',
  name: 'brief.pdf',
  mime: 'application/pdf',
  size: 3,
  local: { key: 'local-f', file, previewUrl: null, progress: 0.5, uploading: true },
};

function paint(
  attachments: MessageAttachment[],
  theme: 'light' | 'dark',
  opts: { album?: boolean } = {},
): string {
  const tree: ReactElement = (
    <div className={theme === 'dark' ? 'dark' : undefined}>
      <MessageAttachments
        attachments={attachments}
        cache={cache()}
        presignEnabled
        voiceSpacer=""
        {...(opts.album === true ? { album: true } : {})}
        onCancelUpload={() => {}}
      />
    </div>
  );
  // Object URLs are random per run; pin them.
  return renderToStaticMarkup(tree).replace(/blob:nodedata:[0-9a-f-]+/g, 'blob:local');
}

/** The ring's own class list. */
function ringClass(html: string): string {
  return /data-upload-ring=""[^>]*class="([^"]*)"/.exec(html)?.[1] ?? '';
}

/** The opening tag (with classes) of the element that directly holds the ring. */
function ringParent(html: string): string {
  const at = html.indexOf('<button type="button" data-upload-ring');
  const stack: string[] = [];
  const VOID = /^<(img|br|hr|input)\b/;
  for (const match of html.slice(0, at).matchAll(/<\/?[a-zA-Z][^>]*>/g)) {
    const tag = match[0];
    if (tag.startsWith('</')) stack.pop();
    else if (!VOID.test(tag) && !tag.endsWith('/>')) stack.push(tag);
  }
  return stack[stack.length - 1] ?? '';
}

describe('T5: UploadRing positioning and sizes', () => {
  it.each(['voice', 'image', 'file'] as const)(
    'the %s ring sets no position of its own',
    (variant) => {
      const cls = renderToStaticMarkup(<UploadRing progress={0.5} variant={variant} />);
      const classes = ringClass(cls).split(/\s+/);
      for (const banned of ['relative', 'absolute', 'fixed', 'sticky']) {
        expect(classes).not.toContain(banned);
      }
      // Nothing inside needs a positioned ancestor either.
      expect(cls).not.toMatch(/class="[^"]*\b(absolute|relative)\b/);
    },
  );

  it('prototype sizes: voice 40, photo and album 56, file 44; X 16; every tap target >= 44', () => {
    expect(UPLOAD_RING_SIZES).toEqual({ voice: 40, image: 56, file: 44 });
    expect(UPLOAD_RING_X).toBe(16);
    const voice = renderToStaticMarkup(<UploadRing progress={0.5} variant="voice" />);
    expect(voice).toContain('viewBox="0 0 40 40"');
    expect(voice).toMatch(/data-upload-disc="" class="[^"]*h-10 w-10/);
    expect(ringClass(voice)).toContain('h-11 w-11');
    expect(voice).toContain('width="16" height="16"');
    const image = renderToStaticMarkup(<UploadRing progress={0.5} variant="image" />);
    expect(image).toContain('viewBox="0 0 56 56"');
    expect(ringClass(image)).toContain('h-14 w-14');
    const fileRing = renderToStaticMarkup(<UploadRing progress={0.5} variant="file" />);
    expect(fileRing).toContain('viewBox="0 0 44 44"');
    expect(ringClass(fileRing)).toContain('h-11 w-11');
  });

  it('light arc on a translucent track over a dark translucent disc (tokens only)', () => {
    const html = renderToStaticMarkup(<UploadRing progress={0.5} variant="image" />);
    expect(html).toContain('bg-overlay opacity-60');
    expect(html).toContain('class="text-overlay-dot"');
    expect(html).toMatch(/data-upload-arc=""[^>]*class="text-overlay-fg/);
    expect(html).not.toMatch(
      new RegExp(['white', 'black', `${String.fromCharCode(35)}[0-9a-f]{3,6}`].join('|'), 'i'),
    );
  });

  it('motion is opacity and stroke only: no spin; the pulse stops with reduced motion', () => {
    const html = renderToStaticMarkup(<UploadRing progress={null} variant="voice" />);
    expect(html).not.toContain('animate-spin');
    expect(html).toContain('animate-pulse motion-reduce:animate-none');
  });

  it('voice: the ring sits absolutely centred inside the relative 44px play slot', () => {
    const html = paint([voiceUploading], 'light');
    expect(ringParent(html)).toContain('data-voice-play-slot="upload"');
    expect(ringParent(html)).toContain('relative h-11 w-11 shrink-0');
    expect(ringClass(html)).toContain(
      'absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2',
    );
    expect(html).toContain('data-ring-variant="voice"');
  });

  it('photo: 56px ring centred over the clipped image', () => {
    const html = paint([photoUploading], 'light');
    expect(ringParent(html)).toContain('relative overflow-hidden');
    expect(ringClass(html)).toContain('absolute left-1/2 top-1/2');
    expect(html).toContain('data-ring-variant="image"');
  });

  it('album: one 56px ring centred over the clipped grid', () => {
    const html = paint(album, 'light', { album: true });
    expect(html.match(/data-upload-ring=/g)).toHaveLength(1);
    expect(ringParent(html)).toMatch(/data-album="3"[^>]*relative[^>]*overflow-hidden/);
    expect(ringClass(html)).toContain('absolute left-1/2 top-1/2');
    expect(html).toContain('data-ring-variant="image"');
  });

  it('file: the file bubble sends with a thin progress bar and no ring', () => {
    const html = paint([fileUploading], 'light');
    expect(html).not.toContain('data-upload-ring');
    expect(html).toContain('data-file-state="sending"');
    expect(html).toContain('data-file-progress=""');
  });
});

describe('T6: upload states in light and dark', () => {
  it.each([
    ['voice uploading', [voiceUploading], false],
    ['voice done with peaks', [voiceDone], false],
    ['photo uploading', [photoUploading], false],
    ['album uploading', album, true],
    ['file uploading', [fileUploading], false],
  ] as const)('%s', (_label, attachments, isAlbum) => {
    const light = paint([...attachments], 'light', { album: isAlbum });
    const dark = paint([...attachments], 'dark', { album: isAlbum });
    // Token-only: the theme wrapper is the only difference.
    expect(dark.replace('<div class="dark">', '<div>')).toBe(light);
    expect(light).toMatchSnapshot('light');
    expect(dark).toMatchSnapshot('dark');
  });

  it('voice done draws the real waveform, not the flat line', () => {
    const html = paint([voiceDone], 'light');
    expect(html).toContain('data-voice-flat="hidden"');
    expect(html).toContain('data-voice-bars="peaks"');
  });
});
