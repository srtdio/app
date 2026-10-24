// The one platform frame box: the post page gallery, both composer paths, the
// composer preview's media and the chat post card / sheet all draw their media
// box here. The frame itself (ratio, cover / contain, bands) comes from frameFor
// in src/lib/platform-specs.ts; this file only sizes and paints it.

import type { CSSProperties, ReactElement, ReactNode } from 'react';
import { ICON_SIZE, IconImagePlus } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import type { Frame, FrameMedia } from '@/lib/platform-specs';
import { cutPercent, type FrameMap } from '@/components/pages/pcs/pin-annotations';
import type { GalleryItem } from '@srtdio/posts';

/** Height caps per surface: the frame narrows to keep its ratio when one bites. */
export const COMPOSER_FRAME_MAX_HEIGHT = '60vh';
export const CHAT_CARD_FRAME_MAX_HEIGHT = '320px';
export const CHAT_SHEET_FRAME_MAX_HEIGHT = '60vh';

/**
 * The frame box: full container width at the frame ratio, never taller than
 * maxHeight (a tall frame narrows instead, so the ratio always holds). Pure.
 */
export function frameBoxStyle(ratio: number, maxHeight: string): CSSProperties {
  return {
    width: `min(100%, calc(${maxHeight} * ${ratio}))`,
    aspectRatio: String(ratio),
  };
}

/** The surface behind the media: black where the platform shows bands, else a token. */
export function frameBandClass(frame: Frame): string {
  return frame.bands === 'none' ? 'bg-panel-2' : 'bg-black';
}

/** How the media fills the frame: centre crop (cover) or whole with bands (contain). */
export function frameMediaClass(frame: Frame): string {
  return frame.fit === 'contain' ? 'h-full w-full object-contain' : 'h-full w-full object-cover';
}

/** "12% outside the Instagram frame." when the frame cuts the media, else null. Pure. */
export function frameCutText(map: FrameMap, platformLabel: string): string | null {
  const pct = cutPercent(map);
  return pct > 0 ? `${pct}% outside the ${platformLabel} frame.` : null;
}

/** A saved gallery item as the frame rule's first media, with its known size. Pure. */
export function galleryItemMedia(
  item: GalleryItem,
  dims: { w: number; h: number } | null,
): FrameMedia {
  const mime = item.mimeType ?? '';
  const kind =
    item.kind === 'image' || mime.startsWith('image/')
      ? 'image'
      : item.kind === 'video' || mime.startsWith('video/')
        ? 'video'
        : 'other';
  return { kind, w: dims?.w ?? null, h: dims?.h ?? null };
}

/**
 * The framed box. empty draws the upload state (token surface, dashed border)
 * instead of the band colour. backdrop is the media drawn behind for blurred
 * bands (YouTube Shorts); ignored for every other frame. bordered false drops
 * the outline where the frame sits inside a card that already has one.
 */
export function PlatformFrame({
  frame,
  maxHeight,
  empty = false,
  bordered = true,
  backdrop,
  className,
  children,
}: {
  frame: Frame;
  maxHeight: string;
  empty?: boolean;
  bordered?: boolean;
  backdrop?: ReactNode;
  className?: string;
  children: ReactNode;
}): ReactElement {
  return (
    <div
      data-frame-ratio={frame.ratio}
      data-frame-fit={frame.fit}
      data-frame-bands={frame.bands}
      {...(empty ? { 'data-frame-empty': '' } : {})}
      style={frameBoxStyle(frame.ratio, maxHeight)}
      className={cn(
        'relative overflow-hidden',
        bordered && 'border',
        empty ? 'border-dashed border-border-strong bg-panel-2' : 'border-border',
        !empty && frameBandClass(frame),
        className,
      )}
    >
      {!empty && frame.bands === 'blur' && backdrop !== undefined ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 scale-110 opacity-70 blur-xl"
        >
          {backdrop}
        </div>
      ) : null}
      {children}
    </div>
  );
}

/** The empty frame as the upload target: the whole box is one button. */
export function PlatformFrameUpload({
  frame,
  maxHeight,
  label,
  disabled = false,
  onPick,
}: {
  frame: Frame;
  maxHeight: string;
  label: string;
  disabled?: boolean;
  onPick: () => void;
}): ReactElement {
  return (
    <PlatformFrame frame={frame} maxHeight={maxHeight} empty className="min-h-[44px] rounded-xl">
      <button
        type="button"
        disabled={disabled}
        onClick={onPick}
        className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-3 text-center text-base text-fg-2 transition-colors hover:bg-panel-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent disabled:pointer-events-none disabled:opacity-60 motion-reduce:transition-none"
      >
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-panel-3 text-accent">
          <IconImagePlus size={ICON_SIZE.tray} />
        </span>
        <span>{label}</span>
      </button>
    </PlatformFrame>
  );
}
