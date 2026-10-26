// The chat file bubble: one PDF, video, Office or other file in a message.
//
// Width is the text bubble's maximum on this device, never the name's: the
// card asks for a full viewport of width (max-content) but needs none
// (min-content 0), so the message column grows to its own max (76% touch, 65%
// laptop) and the card fills it, never wider (BUBBLE_FILL).
// A thumbnail (page 1 of a PDF, a video frame) sits on top; its box takes the
// stored thumbnail's aspect from the message meta, so the height is final on
// first paint and nothing moves when the image arrives. The sender's own file
// shows its local thumbnail while it sends (same reserved box), with a thin
// progress bar and no cancel. No thumbnail: an icon card.
//
// The name wraps to two lines and is then cut in the middle, keeping the
// extension (decision 152). The kind label comes from the mime. Tapping opens
// the in-app FileViewer: never a new tab or window. A viewer that could not
// open leaves "Couldn't open. Try again." on the bubble, tap to retry.

import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { ICON_SIZE, IconPlay } from '@/components/ui/icons';
import { KindIcon, useStoredThumbnail } from '@/components/ui/FileTile';
import {
  FileViewer,
  localFileSource,
  remoteFileSource,
  VIEWER_ERROR,
  type FileViewerSource,
} from '@/components/ui/FileViewer';
import { PressableRow } from '@/components/ui/PressableRow';
import { cn } from '@/lib/cn';
import { humanizeSize } from '@/lib/assets';
import type { PresignCache } from '@/lib/asset-presign';
import {
  classifyFileKind,
  thumbnailMetaOf,
  uploadProgress,
  type FileKind,
  type MessageAttachment,
} from '@/lib/chat/attachments';
import { BUBBLE_NAME_BUDGET, fileKindLabel, middleTruncate } from '@/lib/files/display-name';
import { sharedThumbnail, thumbnailKind } from '@/lib/files/thumbnail';

/**
 * The bubble's width rule as one grid track, minmax(0, 100vw): it asks for a
 * viewport of width, so a shrink-to-fit message column grows to its max, but
 * needs none, so it never pushes the column (or the screen) wider. A plain
 * w-[100vw] made 100vw the minimum too: the sent bubble overflowed the left edge.
 */
export const BUBBLE_FILL = 'grid grid-cols-[minmax(0,100vw)]';

/** Thumbnail box height / width bounds: a tall page is cropped from the top, a wide frame letterboxed. */
const THUMB_RATIO_MIN = 0.5;
const THUMB_RATIO_MAX = 1.3;
/** The box the sender's own sending PDF or video reserves before its thumbnail exists. */
export const SENDING_RATIO: Readonly<Record<'pdf' | 'video', number>> = {
  pdf: THUMB_RATIO_MAX,
  video: 9 / 16,
};

/** Clamp a thumbnail's height / width into the bubble's bounds. Pure. */
export function thumbRatio(width: number, height: number): number {
  if (width <= 0 || height <= 0) return 1;
  return Math.min(Math.max(height / width, THUMB_RATIO_MIN), THUMB_RATIO_MAX);
}

/**
 * The thumbnail box an attachment reserves, as height / width, or null for an
 * icon card. The sender's own pdf/video (its picked file in hand) reserves the
 * kind's sending box for the whole session, so its local thumbnail landing
 * never changes the height; a recorded one reserves its meta's aspect. Pure.
 */
export function reservedRatio(attachment: MessageAttachment): number | null {
  const kind = thumbnailKind(attachment.mime);
  if (kind !== null && attachment.local?.file != null)
    return SENDING_RATIO[kind === 'video' ? 'video' : 'pdf'];
  const meta = thumbnailMetaOf(attachment);
  return meta !== null ? thumbRatio(meta.thumbW, meta.thumbH) : null;
}

/** The line under the name: kind, page count (PDF) and size. Pure. */
export function fileMetaParts(
  attachment: MessageAttachment,
): Array<{ text: string; mono: boolean }> {
  const parts: Array<{ text: string; mono: boolean }> = [
    { text: fileKindLabel(attachment.mime), mono: false },
  ];
  const pages = thumbnailMetaOf(attachment)?.pageCount;
  if (pages !== undefined) {
    parts.push({ text: pages === 1 ? '1 page' : `${pages} pages`, mono: true });
  }
  if (attachment.size !== undefined && attachment.size > 0) {
    parts.push({ text: humanizeSize(attachment.size), mono: true });
  }
  return parts;
}

/** The sender's local thumbnail as an object URL, revoked on unmount. */
function useLocalThumbnail(file: File | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (file === null || thumbnailKind(file.type) === null) return;
    let live = true;
    let made: string | null = null;
    void sharedThumbnail(file).then((result) => {
      if (!live || !result.ok || typeof URL.createObjectURL !== 'function') return;
      made = URL.createObjectURL(result.blob);
      setUrl(made);
    });
    return () => {
      live = false;
      if (made !== null) URL.revokeObjectURL(made);
    };
  }, [file]);
  return url;
}

interface FileBubbleProps {
  attachment: MessageAttachment;
  cache: PresignCache;
  presignEnabled: boolean;
}

/** What the card shows; everything is decided before it renders. */
interface FileBubbleCardProps {
  kind: FileKind;
  /** Thumbnail box height / width, or null for the icon card. */
  ratio: number | null;
  /** The thumbnail image, once there is one. */
  thumbUrl: string | null;
  /** The full name (title and label); shown cut per decision 152. */
  name: string;
  meta: Array<{ text: string; mono: boolean }>;
  /** Upload progress 0..1 while sending; null once sent. */
  progress: number | null;
  /** True while the upload request runs (the bar fills); false while it waits. */
  uploading: boolean;
  /** The last open failed: the inline retry line shows. */
  failed: boolean;
  onOpen: () => void;
  onImageError?: () => void;
}

/**
 * The bubble's card: hook-free, so tests render every state directly. One
 * button (44px+ tall) that opens the file. The thumbnail box is sized from
 * `ratio` alone, so it is the same height before and after the image loads.
 */
export function FileBubbleCard(props: FileBubbleCardProps): ReactElement {
  const { kind, ratio, thumbUrl, progress, uploading, failed } = props;
  const sending = progress !== null;
  return (
    <PressableRow
      type="button"
      onClick={props.onOpen}
      aria-label={`Open ${props.name}`}
      className={cn(
        'relative flex flex-col overflow-hidden border border-border bg-panel',
        'select-none [-webkit-touch-callout:none]',
      )}
    >
      {ratio !== null ? (
        <span
          data-file-thumb=""
          className="relative block w-full overflow-hidden border-b border-border bg-panel-3"
          style={{ aspectRatio: `1 / ${ratio}` }}
        >
          {thumbUrl !== null ? (
            <img
              src={thumbUrl}
              alt=""
              draggable={false}
              onError={props.onImageError}
              className={cn(
                'absolute inset-0 h-full w-full',
                kind === 'video' ? 'object-cover' : 'object-cover object-top',
                uploading && 'opacity-80',
              )}
            />
          ) : (
            <span className="absolute inset-0 flex items-center justify-center text-fg-3">
              <KindIcon kind={kind} size={ICON_SIZE.status} />
            </span>
          )}
          {kind === 'video' && thumbUrl !== null ? (
            <span className="absolute left-1/2 top-1/2 flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-overlay text-overlay-fg">
              <IconPlay size={ICON_SIZE.nav} />
            </span>
          ) : null}
        </span>
      ) : null}
      <span className="flex min-h-[56px] w-full items-center gap-2.5 px-3 py-2.5">
        {ratio === null ? (
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-panel-3 text-fg-3">
            <KindIcon kind={kind} size={ICON_SIZE.control} />
          </span>
        ) : null}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            data-file-name=""
            title={props.name}
            className="text-base font-medium leading-5 text-fg [overflow-wrap:anywhere]"
          >
            {middleTruncate(props.name, BUBBLE_NAME_BUDGET)}
          </span>
          <span className="text-sm text-fg-3">
            {props.meta.map((part, i) => (
              <span key={i}>
                {i > 0 ? ' · ' : null}
                <span className={part.mono ? 'font-mono' : undefined}>{part.text}</span>
              </span>
            ))}
          </span>
          {failed ? (
            <span data-file-error="" role="status" className="text-sm font-medium text-bad">
              {VIEWER_ERROR}
            </span>
          ) : null}
        </span>
      </span>
      {sending ? (
        <span
          data-file-progress=""
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 h-[3px] bg-panel-3"
        >
          <span
            className="block h-full origin-left bg-accent transition-transform duration-base"
            style={{ transform: `scaleX(${uploading ? progress : 0})` }}
          />
        </span>
      ) : null}
    </PressableRow>
  );
}

/** The bubble's data-file-state: sending, error (last open failed) or sent. Pure. */
export function fileBubbleState(sending: boolean, failed: boolean): 'sending' | 'error' | 'sent' {
  return sending ? 'sending' : failed ? 'error' : 'sent';
}

export function FileBubble({ attachment, cache, presignEnabled }: FileBubbleProps): ReactElement {
  const kind = classifyFileKind(attachment.mime);
  const ratio = reservedRatio(attachment);
  const localFile = attachment.local?.file ?? null;
  const progress = uploadProgress(attachment);
  const localThumb = useLocalThumbnail(ratio !== null ? localFile : null);
  const stored = useStoredThumbnail(
    attachment.assetId,
    cache,
    presignEnabled && ratio !== null && localFile === null,
  );
  const [imageFailed, setImageFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const thumbUrl = imageFailed ? null : (localThumb ?? stored.url);

  // A recorded file reads through the Worker; the sender's own file before
  // its upload (or kept for the session) opens from the picked bytes.
  const source = useMemo<FileViewerSource | null>(() => {
    if (localFile !== null) return localFileSource(localFile);
    if (attachment.assetId !== '' && presignEnabled) {
      return remoteFileSource(cache, attachment.assetId);
    }
    return null;
  }, [localFile, attachment.assetId, presignEnabled, cache]);

  const fullName = attachment.name.trim() !== '' ? attachment.name : 'Attachment';

  // Each open is a fresh read; a failure stays on the bubble until the next tap.
  const onOpen = (): void => {
    if (source === null) {
      setOpenFailed(true);
      return;
    }
    setOpenFailed(false);
    setOpen(true);
  };

  return (
    <div
      data-file-bubble={kind}
      data-file-state={fileBubbleState(progress !== null, openFailed)}
      className={BUBBLE_FILL}
    >
      <FileBubbleCard
        kind={kind}
        ratio={ratio}
        thumbUrl={thumbUrl}
        name={fullName}
        meta={fileMetaParts(attachment)}
        progress={progress}
        uploading={attachment.local?.uploading === true}
        failed={openFailed}
        onOpen={onOpen}
        onImageError={() => setImageFailed(true)}
      />
      {open && source !== null ? (
        <FileViewer
          name={fullName}
          kind={kind}
          size={attachment.size}
          source={source}
          onClose={() => setOpen(false)}
          onLoadError={() => setOpenFailed(true)}
        />
      ) : null}
    </div>
  );
}
