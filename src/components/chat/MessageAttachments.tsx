// Renders the attachments on one message. The per-attachment dispatch is
// explicit (classifyAttachment -> branch) so PR6 can add a shared-post branch
// without touching the image / file branches. Each attachment presigns through
// the shared PresignCache, which dedupes in-flight ids and caches URLs, so a
// thread of attachments never fires N+1 presigns and re-renders never re-presign.
//
// An own instant send renders from its local preview (the picked file's object
// URL) for the whole session, before and after it records, so the tile never
// swaps to the presigned URL. While its upload runs the image is dimmed and an
// UploadRing (X in a circle, ring = progress; tap cancels the send) sits
// centred on it (56px): one ring over a whole album (progress across every
// attachment's bytes), one in a voice note's play spot (40px). The ring never
// positions itself; each spot here does. When the upload finishes the X is
// gone; only opacity and the ring's stroke animate, and nothing changes size.
//
// Every other file (PDF, video, Office, anything else) is a FileBubble: a
// fixed-width card with its thumbnail, that sends with a thin progress bar and
// opens in the in-app FileViewer. Nothing here opens a new tab or window.
//
// The whole attachment area sits in its own ErrorBoundary: an attachment that
// throws while rendering shows a compact "Couldn't show this file" card with
// Download, and the rest of the message, thread and app carry on.
//
// Chat groups a message's images into one album (AlbumGrid): the grid is sized
// from the image COUNT alone, so first paint is final and a presigned image
// arriving never shifts layout. Every tile is a real button that opens the
// lightbox at its index; non-image attachments render below the album as before.

import { IconButton } from '@/components/ui/IconButton';
import { PressableRow } from '@/components/ui/PressableRow';
import { useCallback, useEffect, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { ICON_SIZE, IconDownload, IconFile, IconImage } from '@/components/ui/icons';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { downloadFile, remoteFileSource } from '@/components/ui/FileViewer';
import { VoiceNote } from '@/components/chat/VoiceNote';
import { UploadRing } from '@/components/chat/UploadRing';
import { BUBBLE_FILL, FileBubble } from '@/components/chat/FileBubble';
import { cn } from '@/lib/cn';
import { middleTruncate } from '@/lib/files/display-name';
import type { PresignCache } from '@/lib/asset-presign';
import {
  classifyAttachment,
  isVoiceAttachment,
  localAudioUrl,
  splitAlbum,
  uploadProgress,
  uploadRing,
  type MessageAttachment,
} from '@/lib/chat/attachments';

/**
 * Presign one attachment id once, refreshing shortly before expiry and when the
 * page comes back to the foreground (iOS throttles the timer in the
 * background); never throws. `peek` is the cached URL while it is more than 60s
 * from expiry (else null); `refresh` resolves a URL through the cache (force:
 * a new presign) and resolves null on failure. Both work only while enabled.
 */
export function useAttachmentUrl(
  assetId: string,
  cache: PresignCache,
  enabled: boolean,
): {
  url: string | null;
  failed: boolean;
  peek: () => string | null;
  refresh: (force: boolean) => Promise<string | null>;
} {
  const [url, setUrl] = useState<string | null>(() =>
    enabled && assetId !== '' ? (cache.peek(assetId)?.url ?? null) : null,
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!enabled || assetId === '') return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async (): Promise<void> => {
      try {
        const presigned = await cache.resolve(assetId);
        if (!live) return;
        setUrl(presigned.url);
        setFailed(false);
        const delay = Math.max(presigned.expiresAt - Date.now() - 60_000, 5_000);
        timer = setTimeout(() => {
          if (live) void load();
        }, delay);
      } catch {
        if (live) setFailed(true);
      }
    };
    const onVisible = (): void => {
      if (document.visibilityState !== 'visible' || cache.peek(assetId) !== null) return;
      clearTimeout(timer);
      void load();
    };
    void load();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      live = false;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [assetId, cache, enabled]);

  const peek = useCallback(
    (): string | null => (enabled && assetId !== '' ? (cache.peek(assetId)?.url ?? null) : null),
    [assetId, cache, enabled],
  );
  const refresh = useCallback(
    async (force: boolean): Promise<string | null> => {
      if (!enabled || assetId === '') return null;
      try {
        const presigned = await (force ? cache.refresh(assetId) : cache.resolve(assetId));
        setUrl(presigned.url);
        setFailed(false);
        return presigned.url;
      } catch {
        return null;
      }
    },
    [assetId, cache, enabled],
  );

  return { url, failed, peek, refresh };
}

/**
 * Centres an UploadRing over its (relative) image or grid without taking
 * layout space. The container clips (overflow-hidden), so the 56px ring never
 * leaves the bubble.
 */
export const RING_CENTRE = 'absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2';

/**
 * The ring for these attachments while the send can still be cancelled: null
 * when nothing is uploading or the bubble offers no cancel (sent, failed, a
 * peer's message, comments). Pure.
 */
export function ringFor(
  attachments: readonly MessageAttachment[],
  onCancelUpload: (() => void) | undefined,
): { progress: number | null } | null {
  return onCancelUpload !== undefined ? uploadRing(attachments) : null;
}

/**
 * The render branch for one attachment, derived purely from its kind and presign
 * lifecycle so it is unit-testable without a DOM (this codebase renders no React
 * in tests). `image` is a resolved thumbnail, `image-pending` its loading shimmer,
 * `file` the FileBubble (pdf, video, office, other). PR6 extension
 * point: add a 'post' variant here and a case below; the image / file branches
 * stay untouched.
 */
export type AttachmentView =
  | { kind: 'image'; src: string; alt: string }
  /** An own instant send: its local preview, with upload progress until the version id lands. */
  | { kind: 'image-local'; src: string; alt: string; progress: number | null }
  | { kind: 'image-pending'; alt: string }
  | {
      kind: 'audio';
      url: string | null;
      name: string;
      durationMs: number | undefined;
      /** Own instant send: upload progress until the version id lands; null once sent. */
      progress: number | null;
    }
  | { kind: 'file'; name: string; url: string | null; progress?: number };

/**
 * A chat voice note's message context: its id (played state and transcript
 * key), side, sender photo, the voice note right below it from the same
 * sender (auto-play next), if any, the bubble's time (drawn inside the note's
 * last row) and, on a received recorded note, the tap-to-transcribe flow.
 */
export interface VoiceContext {
  messageId: string;
  mine: boolean;
  sender: { name: string; src?: string | undefined };
  nextVoiceId: string | null;
  meta?: ReactNode;
  onTranscribe?: (() => void) | undefined;
}

export function attachmentView(args: {
  attachment: MessageAttachment;
  presignEnabled: boolean;
  url: string | null;
  failed: boolean;
  /** An own voice note's recorded file (object URL); plays before and after the upload. */
  localUrl?: string | null;
}): AttachmentView {
  const { attachment, presignEnabled, url, failed } = args;
  const progress = uploadProgress(attachment);
  const previewUrl = attachment.local?.previewUrl ?? null;
  if (classifyAttachment(attachment.mime) === 'image' && previewUrl !== null) {
    return { kind: 'image-local', src: previewUrl, alt: attachment.name, progress };
  }
  // A voice note is always the voice bubble, uploading or sent, so the switch
  // never changes its size; it plays from the local file when there is one.
  if (isVoiceAttachment(attachment)) {
    const localUrl = args.localUrl ?? null;
    return {
      kind: 'audio',
      url: localUrl ?? (presignEnabled && !failed ? url : null),
      name: attachment.name,
      durationMs: attachment.durationMs,
      progress,
    };
  }
  if (progress !== null) {
    return { kind: 'file', name: attachment.name, url: null, progress };
  }
  if (classifyAttachment(attachment.mime) === 'image' && presignEnabled && !failed) {
    return url !== null
      ? { kind: 'image', src: url, alt: attachment.name }
      : { kind: 'image-pending', alt: attachment.name };
  }
  return { kind: 'file', name: attachment.name, url };
}

function AttachmentItem({
  attachment,
  cache,
  presignEnabled,
  onImageClick,
  voiceSpacer,
  voice,
  onCancelUpload,
}: {
  attachment: MessageAttachment;
  cache: PresignCache;
  presignEnabled: boolean;
  onImageClick?: (() => void) | undefined;
  voiceSpacer?: ReactNode;
  voice?: VoiceContext | undefined;
  /** An own send that can still be cancelled: the X cancels it. */
  onCancelUpload?: (() => void) | undefined;
}): ReactElement {
  const ring = ringFor([attachment], onCancelUpload);
  // The render layer presigns the attachment's VERSION id (assetId carries the
  // asset_versions.id) through the shared cache, which dedupes in-flight ids.
  // A local preview (or an own voice note's recorded file) is the source for
  // the session: it never presigns.
  const localUrl = isVoiceAttachment(attachment) ? localAudioUrl(attachment) : null;
  const hasPreview = attachment.local?.previewUrl != null || localUrl !== null;
  // A file bubble never uses the file's own link (it presigns its thumbnail
  // and the viewer asks for a fresh link on open): only images and voice notes do.
  const needsUrl = classifyAttachment(attachment.mime) !== 'file' || isVoiceAttachment(attachment);
  const presigned = presignEnabled && !hasPreview && needsUrl;
  const { url, failed, peek, refresh } = useAttachmentUrl(attachment.assetId, cache, presigned);
  const view = attachmentView({ attachment, presignEnabled, url, failed, localUrl });

  switch (view.kind) {
    case 'image': {
      const image = (
        <img
          src={view.src}
          alt={view.alt}
          draggable={false}
          className="max-h-48 max-w-[260px] rounded-lg border border-border object-cover"
        />
      );
      // When the caller wants tap-to-open (comments), wrap the unchanged <img> in
      // a button; chat passes no onImageClick so it renders exactly as before.
      return onImageClick !== undefined ? (
        <PressableRow
          inline
          type="button"
          aria-label="Open image"
          onClick={onImageClick}
          className="cursor-zoom-in"
        >
          {image}
        </PressableRow>
      ) : (
        image
      );
    }
    case 'image-local':
      return (
        <div className="relative overflow-hidden rounded-lg border border-border">
          <img
            src={view.src}
            alt={view.alt}
            draggable={false}
            className={cn(
              'block max-h-48 max-w-[260px] object-cover',
              view.progress !== null && 'brightness-75',
            )}
          />
          {ring !== null ? (
            <UploadRing
              progress={ring.progress}
              onCancel={onCancelUpload}
              variant="image"
              className={RING_CENTRE}
            />
          ) : null}
        </div>
      );
    case 'image-pending':
      return <div className="h-32 w-44 animate-pulse rounded-lg border border-border bg-panel-2" />;
    case 'audio':
      // One wrapper in both states; the ring sits in the play spot, so the
      // bubble keeps its size when the upload completes (X becomes play).
      return (
        <div data-voice-upload={ring !== null ? '' : undefined} className="relative">
          <VoiceNote
            url={view.url}
            name={view.name}
            mime={attachment.mime}
            durationMs={view.durationMs}
            {...(presigned ? { peekUrl: peek, refreshUrl: refresh } : {})}
            bubbleInset={voice !== undefined}
            peaks={attachment.peaks}
            storedTranscript={attachment.transcript}
            {...(onCancelUpload !== undefined && attachment.local !== undefined
              ? {
                  upload: {
                    active: ring !== null,
                    progress: ring?.progress ?? null,
                    onCancel: onCancelUpload,
                  },
                }
              : {})}
            {...(voiceSpacer !== undefined ? { spacer: voiceSpacer } : {})}
            {...(voice !== undefined ? voice : {})}
          />
        </div>
      );
    case 'file':
      // Sends with its own thin bar, no cancel; tap opens the in-app viewer.
      return <FileBubble attachment={attachment} cache={cache} presignEnabled={presignEnabled} />;
  }
}

/** One album tile: the image it shows, its grid classes, and the "+N" overflow count. */
export interface AlbumTile {
  index: number;
  className: string;
  /** Images beyond the fourth, shown as "+N" on the fourth tile; 0 shows none. */
  more: number;
}

/** The album grid's column template by count: one column for a single image, else two. */
export function albumGridClass(count: number): string {
  return count === 1 ? 'grid grid-cols-1' : 'grid grid-cols-2';
}

/**
 * Tile layout by image count, derived from the count alone so the grid never
 * waits on an image load. 1: one full-width tile (4:3 box, capped at 320px, the
 * image object-cover inside it). 2: two squares. 3: a 2:1 wide tile over two
 * squares. 4 or more: a 2x2 of squares, the fourth carrying "+N" (N = count - 4)
 * when there are more. Pure.
 */
export function albumTiles(count: number): AlbumTile[] {
  if (count <= 0) return [];
  if (count === 1) return [{ index: 0, className: 'aspect-[4/3] max-h-[320px]', more: 0 }];
  if (count === 2) {
    return [0, 1].map((index) => ({ index, className: 'aspect-square', more: 0 }));
  }
  if (count === 3) {
    return [
      { index: 0, className: 'col-span-2 aspect-[2/1]', more: 0 },
      { index: 1, className: 'aspect-square', more: 0 },
      { index: 2, className: 'aspect-square', more: 0 },
    ];
  }
  return [0, 1, 2, 3].map((index) => ({
    index,
    className: 'aspect-square',
    more: index === 3 ? count - 4 : 0,
  }));
}

/** The tile button's accessible name: "Open photo i of n" (1-based). Pure. */
export function albumTileLabel(index: number, count: number): string {
  return `Open photo ${index + 1} of ${count}`;
}

/**
 * The image inside one album tile. It fills the tile absolutely (object-cover),
 * so the tile's size comes from the grid, never from the image. Until the
 * presigned image arrives the tile's own bg-panel-3 shows; an own instant send
 * shows its local preview, dimmed while it uploads (the album's one ring sits
 * over the grid). A failed
 * or disabled presign keeps the tile with a centred image glyph (the lightbox
 * owns the retry).
 */
function AlbumTileImage({
  attachment,
  cache,
  presignEnabled,
}: {
  attachment: MessageAttachment;
  cache: PresignCache;
  presignEnabled: boolean;
}): ReactElement | null {
  const hasPreview = attachment.local?.previewUrl != null;
  const { url, failed } = useAttachmentUrl(
    attachment.assetId,
    cache,
    presignEnabled && !hasPreview,
  );
  const view = attachmentView({ attachment, presignEnabled, url, failed });
  const src = view.kind === 'image' || view.kind === 'image-local' ? view.src : null;
  const progress =
    view.kind === 'image-local'
      ? view.progress
      : view.kind === 'file'
        ? (view.progress ?? null)
        : null;
  return (
    <>
      {src !== null ? (
        <img
          src={src}
          alt={attachment.name}
          draggable={false}
          className={cn(
            'absolute inset-0 h-full w-full object-cover',
            progress !== null && 'brightness-75',
          )}
        />
      ) : view.kind === 'file' && progress === null ? (
        <span className="absolute inset-0 flex items-center justify-center text-fg-3">
          <IconImage size={ICON_SIZE.tray} />
        </span>
      ) : null}
    </>
  );
}

/**
 * The album: every image of one message in a count-sized grid, tiles 2px apart,
 * 15px outer corners (the 18px bubble minus its 3px padding). Hook-free (the
 * per-tile presign lives in AlbumTileImage) so tests can call it directly. Each
 * tile is a real button; tapping opens the viewer at that index, and the "+N"
 * tile opens at index 3. The overlay is white on black/50, theme-independent.
 */
export function AlbumGrid({
  images,
  cache,
  presignEnabled,
  onOpen,
  ring = null,
  onCancelUpload,
}: {
  images: readonly MessageAttachment[];
  cache: PresignCache;
  presignEnabled: boolean;
  onOpen: (index: number) => void;
  /** The one upload ring over the grid (progress across the whole message); null: none. */
  ring?: { progress: number | null } | null;
  onCancelUpload?: (() => void) | undefined;
}): ReactElement {
  const count = images.length;
  return (
    <div
      data-album={count}
      className={cn(
        albumGridClass(count),
        'relative w-[320px] max-w-full gap-[2px] overflow-hidden rounded-xl',
      )}
    >
      {albumTiles(count).map((tile) => {
        const attachment = images[tile.index] as MessageAttachment;
        return (
          <PressableRow
            key={attachment.local?.key ?? `${attachment.assetId}-${tile.index}`}
            flat
            type="button"
            aria-label={albumTileLabel(tile.index, count)}
            onClick={() => onOpen(tile.index)}
            className={cn(
              'relative block cursor-zoom-in overflow-hidden bg-panel-3 [-webkit-touch-callout:none]',
              'focus-visible:ring-inset',
              tile.className,
            )}
          >
            <AlbumTileImage attachment={attachment} cache={cache} presignEnabled={presignEnabled} />
            {tile.more > 0 ? (
              <span
                aria-hidden="true"
                className="absolute inset-0 flex items-center justify-center bg-black/50 text-2xl font-semibold text-white"
              >
                +{tile.more}
              </span>
            ) : null}
          </PressableRow>
        );
      })}
      {ring !== null ? (
        <UploadRing
          progress={ring.progress}
          onCancel={onCancelUpload}
          variant="image"
          className={RING_CENTRE}
        />
      ) : null}
    </div>
  );
}

/** The props of one message's attachment area. */
export interface MessageAttachmentsProps {
  attachments: readonly MessageAttachment[];
  cache: PresignCache;
  presignEnabled: boolean;
  /**
   * Optional: tap an image to open it. `index` is the image's position in the
   * album (album mode) or in the attachment list (comments, which ignores it).
   */
  onImageClick?: ((attachment: MessageAttachment, index: number) => void) | undefined;
  /**
   * Chat: group the images into one album (AlbumGrid) with the rest below. The
   * caller turns it on only when the message carries at least one image.
   */
  album?: boolean;
  /** Album mode: the caption (message text), rendered right under the album. */
  caption?: ReactNode;
  /**
   * Chat voice-only bubbles: the inline time spacer a voice note ends with, and
   * the list sits flush in the bubble (no top margin, full width).
   */
  voiceSpacer?: ReactNode;
  /** Chat voice-only bubbles: the recorded message the note belongs to. */
  voice?: VoiceContext | undefined;
  /**
   * An own send whose upload can still be cancelled: each uploading photo,
   * album, file or voice note shows the UploadRing, whose X calls this.
   */
  onCancelUpload?: (() => void) | undefined;
}

/** "Couldn't show this file": the attachment area's crash fallback. */
export const ATTACHMENT_FALLBACK = "Couldn't show this file";

/**
 * What a message shows when its attachment area threw while rendering: one
 * compact card per attachment, its name, the line above and Download (a fresh
 * attachment link, same window). Hook-free, so it cannot throw the same way.
 */
export function AttachmentsFallback(props: {
  attachments: readonly MessageAttachment[];
  cache: PresignCache;
  presignEnabled: boolean;
}): ReactElement {
  return (
    <div data-attachments-fallback="" className={cn('mt-1.5 gap-1.5', BUBBLE_FILL)}>
      {props.attachments.map((attachment, index) => {
        const name = attachment.name.trim() !== '' ? attachment.name : 'Attachment';
        const canDownload = props.presignEnabled && attachment.assetId !== '';
        return (
          <div
            key={`${attachment.assetId}-${index}`}
            className="flex min-w-0 items-center gap-2.5 rounded-xl border border-border bg-panel px-3 py-2"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-panel-3 text-fg-3">
              <IconFile size={ICON_SIZE.nav} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-base font-medium text-fg [overflow-wrap:anywhere]" title={name}>
                {middleTruncate(name)}
              </span>
              <span className="text-sm text-fg-3">{ATTACHMENT_FALLBACK}</span>
            </span>
            {canDownload ? (
              <IconButton
                type="button"
                label={`Download ${name}`}
                onClick={() =>
                  void downloadFile(remoteFileSource(props.cache, attachment.assetId), name)
                }
                className="shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <IconDownload size={ICON_SIZE.control} />
              </IconButton>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * One message's attachments inside their own error boundary: a throw in any
 * attachment shows AttachmentsFallback for this message only.
 */
export function MessageAttachments(props: MessageAttachmentsProps): ReactElement | null {
  if (props.attachments.length === 0) return null;
  return (
    <ErrorBoundary
      name="chat-attachment"
      context={{ attachment_count: props.attachments.length }}
      fallback={
        <AttachmentsFallback
          attachments={props.attachments}
          cache={props.cache}
          presignEnabled={props.presignEnabled}
        />
      }
    >
      <MessageAttachmentsBody {...props} />
    </ErrorBoundary>
  );
}

function MessageAttachmentsBody({
  attachments,
  cache,
  presignEnabled,
  onImageClick,
  voiceSpacer,
  voice,
  album,
  caption,
  onCancelUpload,
}: MessageAttachmentsProps): ReactElement | null {
  if (attachments.length === 0) return null;
  if (album === true) {
    const { images, others } = splitAlbum(attachments);
    if (images.length > 0) {
      const hasBelow = caption != null || others.length > 0;
      return (
        <div data-album-block="" className="flex flex-col">
          <AlbumGrid
            images={images}
            cache={cache}
            presignEnabled={presignEnabled}
            onOpen={(index) => {
              const attachment = images[index];
              if (attachment !== undefined) onImageClick?.(attachment, index);
            }}
            // ONE ring for the whole message: the chips below carry none.
            ring={ringFor(attachments, onCancelUpload)}
            onCancelUpload={onCancelUpload}
          />
          {hasBelow ? (
            <div className="flex flex-col items-start gap-1.5 px-[9px] pb-[5px] pt-1.5">
              {caption}
              {others.map((attachment, index) => (
                <AttachmentItem
                  key={attachment.local?.key ?? `${attachment.assetId}-${index}`}
                  attachment={attachment}
                  cache={cache}
                  presignEnabled={presignEnabled}
                />
              ))}
            </div>
          ) : null}
        </div>
      );
    }
  }
  return (
    <div
      className={cn(
        'flex flex-col gap-1.5',
        voiceSpacer !== undefined || voice !== undefined ? 'items-stretch' : 'mt-1.5 items-start',
      )}
    >
      {attachments.map((attachment, index) => (
        <AttachmentItem
          key={attachment.local?.key ?? `${attachment.assetId}-${index}`}
          attachment={attachment}
          cache={cache}
          presignEnabled={presignEnabled}
          onImageClick={
            onImageClick !== undefined ? () => onImageClick(attachment, index) : undefined
          }
          {...(voiceSpacer !== undefined ? { voiceSpacer } : {})}
          voice={voice}
          onCancelUpload={onCancelUpload}
        />
      ))}
    </div>
  );
}
