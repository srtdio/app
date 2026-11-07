import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { UPLOAD_RING_SIZES, UPLOAD_RING_STOP, UploadRing } from '@/components/chat/UploadRing';
import { MessageAttachments } from '@/components/chat/MessageAttachments';
import { FileBubbleCard, FileSendingRing } from '@/components/chat/FileBubble';
import { FailedActions, MetaGlyph, bubbleStatus, metaTick } from '@/components/chat/MessageThread';
import { ringCircumference, ringDashOffset } from '@/components/ui/ProgressRing';
import { ICON_SIZE, IconClock, IconStop } from '@/components/ui/icons';
import { PresignCache, type PresignDeps } from '@/lib/asset-presign';
import type { MessageAttachment } from '@/lib/chat/attachments';

// T5: the ring never positions itself; each caller places it, at the
// prototype's size. T6: the upload states in light and dark (token-only
// markup, so the two themes render the same classes). D5: the sending states
// (queued, uploading, failed, sent, stopped) with one look on every type.

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
  // A PressableRow: class renders before the passed data attributes.
  return /<button[^>]*class="([^"]*)"[^>]*data-upload-ring=""/.exec(html)?.[1] ?? '';
}

/** The opening tag (with classes) of the box that directly holds the ring. */
function ringParent(html: string): string {
  const at = html.lastIndexOf('<button', html.indexOf('data-upload-ring'));
  const stack: string[] = [];
  const VOID = /^<(img|br|hr|input)\b/;
  for (const match of html.slice(0, at).matchAll(/<\/?[a-zA-Z][^>]*>/g)) {
    const tag = match[0];
    if (tag.startsWith('</')) stack.pop();
    else if (!VOID.test(tag) && !tag.endsWith('/>')) stack.push(tag);
  }
  // The tile ring's display: contents wrapper adds no box: look past it.
  return [...stack].reverse().find((tag) => !tag.includes('data-tile-upload-ring')) ?? '';
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

  it('prototype sizes: voice 40, photo/album 56, file 44; stop 16; tap targets >= 44', () => {
    expect(UPLOAD_RING_SIZES).toEqual({ voice: 40, image: 56, file: 44 });
    expect(UPLOAD_RING_STOP).toBe(16);
    const voice = renderToStaticMarkup(<UploadRing progress={0.5} variant="voice" />);
    expect(voice).toContain('viewBox="0 0 40 40"');
    expect(voice).toMatch(/data-upload-disc="" class="[^"]*h-10 w-10/);
    expect(ringClass(voice)).toContain('h-11 min-w-11');
    expect(voice).toContain('width="16" height="16"');
    const image = renderToStaticMarkup(<UploadRing progress={0.5} variant="image" />);
    expect(image).toContain('viewBox="0 0 56 56"');
    expect(ringClass(image)).toContain('h-14 min-w-14');
    const fileRing = renderToStaticMarkup(<UploadRing progress={0.5} variant="file" />);
    expect(fileRing).toContain('viewBox="0 0 44 44"');
    expect(ringClass(fileRing)).toContain('h-11 min-w-11');
  });

  it('light arc on a translucent track over a dark translucent disc (tokens only)', () => {
    const html = renderToStaticMarkup(<UploadRing progress={0.5} variant="image" />);
    expect(html).toContain('bg-overlay opacity-60');
    expect(html).toContain('class="text-overlay-dot"');
    expect(html).toMatch(/data-upload-arc=""[^>]*class="[^"]*text-overlay-fg/);
    expect(html).not.toMatch(
      new RegExp(['white', 'black', `${String.fromCharCode(35)}[0-9a-f]{3,6}`].join('|'), 'i'),
    );
  });

  it('motion: the arc fills (mv-fill); unknown sits at 0, never spins or fades', () => {
    const html = renderToStaticMarkup(<UploadRing progress={null} variant="voice" />);
    expect(html).not.toContain('animate-spin');
    expect(html).not.toContain('animate-pulse');
    expect(html).not.toContain('mv-spin');
    expect(html).toMatch(/data-upload-arc=""[^>]*class="[^"]*mv-fill/);
    expect(html).not.toMatch(/transition-|duration-/);
    const known = renderToStaticMarkup(<UploadRing progress={0.5} variant="voice" />);
    expect(known).not.toContain('mv-spin');
  });

  it('done: the ring scales to 0 in place (mv-ring-out), not focusable', () => {
    const html = renderToStaticMarkup(<UploadRing progress={1} variant="voice" hidden />);
    expect(ringClass(html)).toContain('pointer-events-none mv-ring-out');
    expect(html).toContain('tabindex="-1"');
    expect(ringClass(html)).not.toMatch(/opacity-0|invisible/);
  });

  it('voice: the ring sits absolutely centred inside the relative 44px play slot', () => {
    const html = paint([voiceUploading], 'light');
    expect(ringParent(html)).toContain('data-voice-play-slot="upload"');
    expect(ringParent(html)).toContain('relative h-11 w-11 shrink-0');
    expect(ringClass(html)).toContain(
      'absolute left-1/2 top-1/2 z-raised -translate-x-1/2 -translate-y-1/2',
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

  it('file: the file bubble sends with the 44px ring over its page box, no thin bar', () => {
    const html = paint([fileUploading], 'light');
    expect(html.match(/data-upload-ring=""/g)).toHaveLength(1);
    expect(html).toContain('data-ring-variant="file"');
    expect(html).toContain('data-file-state="sending"');
    expect(html).not.toContain('data-file-progress');
    expect(ringParent(html)).toContain('data-file-ring=""');
    // A sending pdf reserves the page box, so the ring sits centred over it.
    expect(ringParent(html)).toContain('absolute inset-x-px top-px flex');
    expect(ringParent(html)).toContain('aspect-ratio:1 / 1.3');
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
  });

  it('voice done draws the real waveform at full emphasis', () => {
    const html = paint([voiceDone], 'light');
    expect(html).not.toContain('data-voice-flat');
    expect(html).not.toMatch(/data-voice-bars="peaks" class="[^"]*opacity-\[\.45\]/);
    expect(html).toContain('data-voice-bars="peaks"');
  });
});

describe('U6: the voice ring draws in the bubble inks', () => {
  function voicePaint(mine: boolean): string {
    return renderToStaticMarkup(
      <MessageAttachments
        attachments={[voiceUploading]}
        cache={cache()}
        presignEnabled
        voice={{
          messageId: 'm-voice',
          mine,
          sender: { name: 'Asha Rao' },
          nextVoiceId: null,
        }}
        onCancelUpload={() => {}}
      />,
    ).replace(/blob:nodedata:[0-9a-f-]+/g, 'blob:local');
  }

  it('ink replaces the overlay disc and ink, with no shadow', () => {
    const html = renderToStaticMarkup(
      <UploadRing
        progress={0.5}
        variant="voice"
        ink={{ disc: 'bg-panel-3', track: 'text-fg-3', arc: 'text-accent' }}
      />,
    );
    expect(html).not.toContain('bg-overlay');
    expect(html).not.toContain('text-overlay');
    expect(html).not.toContain('lit-media');
    expect(html).toMatch(/data-upload-disc="" class="[^"]*bg-panel-3/);
    expect(html).toContain('class="text-fg-3"');
    expect(html).toMatch(/data-upload-arc=""[^>]*class="[^"]*text-accent/);
    expect(ringClass(html)).toContain('text-accent');
  });

  it('an own note uploading: the own-bubble inks, the testid and the real bars at .45', () => {
    const html = voicePaint(true);
    expect(html).toContain('data-testid="voice-uploading"');
    expect(html).toContain('data-voice-side="own"');
    expect(html).toMatch(/data-upload-disc="" class="[^"]*bg-on-bubble\/\[\.12\]/);
    expect(html).toContain('class="text-on-bubble/[.45]"');
    expect(html).toMatch(/data-upload-arc=""[^>]*class="[^"]*text-accent-fg/);
    expect(html).not.toContain('bg-overlay');
    expect(html).toMatch(/data-voice-bars="[a-z]+" class="[^"]*opacity-\[\.45\]/);
    expect(html).not.toContain('data-voice-flat');
  });

  it('a peer-side voice ring takes the peer bubble inks', () => {
    const html = voicePaint(false);
    expect(html).toContain('data-voice-side="received"');
    expect(html).toMatch(/data-upload-disc="" class="[^"]*bg-panel-3/);
    expect(html).toMatch(/data-upload-arc=""[^>]*class="[^"]*text-accent(?!-)/);
    expect(html).not.toContain('bg-overlay');
  });
});

/** The arc's stroke offset in a ring's markup. */
function arcOffset(html: string): number {
  return Number(/data-upload-arc=""[^>]*stroke-dashoffset="([^"]+)"/.exec(html)?.[1] ?? NaN);
}

describe('D5: sending states, one look across photo, album, video, file, voice note', () => {
  const stop = renderToStaticMarkup(
    <IconStop size={UPLOAD_RING_STOP} className="[grid-area:1/1]" />,
  );

  it.each(['voice', 'image', 'file'] as const)(
    'uploading (%s): the stop square (IconStop) inside the ring, labelled "Stop sending"',
    (variant) => {
      const html = renderToStaticMarkup(
        <UploadRing progress={0.5} variant={variant} onCancel={() => {}} />,
      );
      expect(html).toContain(stop);
      expect(html).toContain('aria-label="Stop sending"');
      expect(html).not.toContain('Cancel upload');
      // No X path (the old close glyph) anywhere in the control.
      expect(html).not.toContain('M6 18 18 6M6 6l12 12');
    },
  );

  it('the label follows the caller (Stop upload, Stop recording)', () => {
    const upload = renderToStaticMarkup(
      <UploadRing progress={0.5} variant="image" label="Stop upload" />,
    );
    expect(upload).toContain('aria-label="Stop upload"');
    const recording = renderToStaticMarkup(
      <UploadRing progress={0.5} variant="voice" label="Stop recording" />,
    );
    expect(recording).toContain('aria-label="Stop recording"');
  });

  it.each([0, 0.5, 1])('the arc reflects real progress %s (fills 0 to 100)', (progress) => {
    const html = renderToStaticMarkup(<UploadRing progress={progress} variant="image" />);
    const size = UPLOAD_RING_SIZES.image;
    expect(arcOffset(html)).toBeCloseTo(ringDashOffset(progress, size, 3, 0));
    expect(arcOffset(html)).toBeCloseTo(ringCircumference(size, 3) * (1 - progress));
    expect(html).toContain(`data-upload-progress="${String(Math.round(progress * 100))}"`);
    expect(html).toContain(`aria-valuenow="${String(Math.round(progress * 100))}"`);
  });

  it('unknown progress at the start shows an empty ring (0), then fills', () => {
    const unknown = renderToStaticMarkup(<UploadRing progress={null} variant="image" />);
    const size = UPLOAD_RING_SIZES.image;
    expect(arcOffset(unknown)).toBeCloseTo(ringCircumference(size, 3));
    expect(unknown).toContain('data-upload-progress="unknown"');
    const half = renderToStaticMarkup(<UploadRing progress={0.5} variant="image" />);
    expect(arcOffset(half)).toBeLessThan(arcOffset(unknown));
    const done = renderToStaticMarkup(<UploadRing progress={1} variant="image" />);
    expect(arcOffset(done)).toBe(0);
  });

  it('over media: overlay ink on a dark overlay disc (reads on light and dark)', () => {
    const html = renderToStaticMarkup(<UploadRing progress={0.5} variant="image" />);
    expect(ringClass(html)).toContain('text-overlay-fg');
    expect(html).toMatch(/data-upload-disc="" class="[^"]*bg-overlay/);
    expect(html).not.toContain('text-white');
  });

  it('stop calls the cancel path (the pending message goes) and never reaches the bubble', () => {
    const onCancel = vi.fn();
    const tree = UploadRing({ progress: 0.5, variant: 'file', onCancel }) as ReactElement<{
      children: ReactElement[];
    }>;
    const button = tree.props.children[0] as ReactElement<{
      onClick: (e: { stopPropagation: () => void }) => void;
    }>;
    const stopPropagation = vi.fn();
    button.props.onClick({ stopPropagation });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(stopPropagation).toHaveBeenCalled();
  });

  it('voice note uploading: the ring replaces the play glyph in the same 44px box', () => {
    const html = paint([voiceUploading], 'light');
    // The slot keeps its box; play is still there (so the wave never moves) but invisible.
    expect(html).toMatch(/data-voice-play-slot="upload" class="relative h-11 w-11 shrink-0"/);
    const play = /<button[^>]*data-voice-control=""[^>]*>/.exec(html)?.[0] ?? '';
    expect(play).toContain('aria-label="Play voice note"');
    expect(play).toMatch(/class="[^"]*\binvisible\b/);
    expect(ringParent(html)).toContain('data-voice-play-slot="upload"');
    // Never larger than the play button: a 40px ring in a 44px hit box.
    expect(ringClass(html)).toContain('h-11 min-w-11');
    expect(html).toContain('viewBox="0 0 40 40"');
    expect(html).toContain('aria-label="Stop sending"');
  });

  it('photo and album uploading: a ring with the stop square over the clipped media', () => {
    expect(paint([photoUploading], 'light')).toContain(stop);
    const albumHtml = paint(album, 'light', { album: true });
    expect(albumHtml.match(/data-upload-ring=""/g)).toHaveLength(1);
    expect(albumHtml).toContain(stop);
  });

  it('video uploading: the ring takes the play button spot (no play glyph)', () => {
    const sending = renderToStaticMarkup(
      <div className="relative">
        <FileBubbleCard
          kind="video"
          ratio={9 / 16}
          thumbUrl="blob:frame"
          name="clip.mp4"
          meta={[{ text: 'Video', mono: false }]}
          progress={0.3}
          uploading
          failed={false}
          onOpen={() => {}}
        />
        <FileSendingRing ratio={9 / 16} progress={0.3} onCancel={() => {}} />
      </div>,
    );
    expect(sending).not.toContain('bg-overlay text-overlay-fg lit-media');
    expect(sending).toContain('data-file-ring=""');
    expect(sending).toContain('absolute inset-x-px top-px flex items-center justify-center');
    expect(sending).toContain(stop);
    expect(sending).toContain('aria-label="Stop sending"');
  });

  it('file uploading: no thin bar; the icon keeps its box under the ring', () => {
    const html = renderToStaticMarkup(
      <FileBubbleCard
        kind="file"
        ratio={null}
        thumbUrl={null}
        name="notes.zip"
        meta={[{ text: 'File', mono: false }]}
        progress={0.5}
        uploading
        failed={false}
        onOpen={() => {}}
      />,
    );
    expect(html).not.toContain('data-file-progress');
    expect(html).toContain('class="flex invisible"');
  });

  it('queued: a clock (IconClock) in the time chip', () => {
    const status = bubbleStatus(
      { mine: true, state: 'sending', status: 'sent' },
      { showTicks: true },
    );
    expect(status).toBe('sending');
    const tick = metaTick(status);
    expect(tick).toBe('sending');
    const html = renderToStaticMarkup(<MetaGlyph status="sending" />);
    expect(html).toContain(renderToStaticMarkup(<IconClock size={ICON_SIZE.text} />));
    expect(html).toContain('aria-label="Sending"');
  });

  it('failed: stays in the thread with "Not sent" and Retry', () => {
    expect(bubbleStatus({ mine: true, state: 'failed', status: 'sent' }, { showTicks: true })).toBe(
      'failed',
    );
    const html = renderToStaticMarkup(<FailedActions onRetry={() => {}} onDelete={() => {}} />);
    expect(html).toContain('Not sent');
    expect(html).toContain('Retry');
  });

  it('sent: time only (no live ring, no clock)', () => {
    const photoSent: MessageAttachment = {
      ...photoUploading,
      assetId: '44444444-4444-4444-8444-444444444444',
      local: { ...photoUploading.local!, progress: 1, uploading: false },
    };
    expect(paint([photoSent], 'light')).not.toContain('data-upload-ring');
    expect(
      bubbleStatus({ mine: true, state: 'sent', status: 'sent' }, { showTicks: false }),
    ).toBeNull();
  });
});

describe('D4b: no close X in the sending-state files', () => {
  const OWNED = [
    'chat/UploadRing.tsx',
    'chat/VoiceNote.tsx',
    'chat/FileBubble.tsx',
    'ui/ProgressRing.tsx',
    'pages/assets/AssetUploadSheet.tsx',
    'induction/PresetMediaField.tsx',
  ];
  const ROOT = fileURLToPath(new URL('../', import.meta.url));

  // Names assembled so a repo-wide grep for the retired glyph skips this guard.
  const RETIRED = new RegExp(['\\bIcon', 'X\\b|\\bXMark', 'Icon\\b'].join(''));

  it.each(OWNED)('%s uses no close X glyph', (rel) => {
    const src = readFileSync(`${ROOT}${rel}`, 'utf8');
    expect(src).not.toMatch(RETIRED);
  });
});
