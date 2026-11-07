// The one upload indicator (decision F, 7 Nov): on an uploading photo, album,
// video, file, voice note, Assets row thumb, post tile, onboarding photo or a
// pending-file chip thumb. A 16px X (IconX) on a dark scrim disc, with a ring around it that fills with the
// upload's real progress 0..1 (a light arc on a translucent track). Tapping
// the X cancels (no confirm): the caller's cancel removes the pending
// message. While progress is unknown (queued, waiting, backoff, offline) the
// arc sits at 0 and fills once bytes move; it never spins ahead of the upload.
//
// It never positions itself: the caller does (absolutely centred in the voice
// play slot, over an image or a video, or over a file's icon spot). Its layers
// stack in one grid cell, so nothing inside needs a positioned ancestor either.
// Sizes follow the approved prototype: voice 40, photo and album 56, file 44;
// the button is never under 44x44 (the voice ring sits in a 44px button, the
// play button's own box, so it is never larger than play).
//
// A failed upload shows Retry in the same spot (UploadRetry): the same disc
// with IconRotateCcw, labelled "Retry". No bars and no % text anywhere.
//
// Over media it draws on the overlay tokens (a dark disc, light ink, the same
// values in light and dark), so the X reads on light and dark media.
// In the voice play slot the caller hands the bubble's own inks instead (`ink`:
// a flat disc, a track and the arc and X in the play glyph's ink),
// with no shadow, so nothing paints past the slot. The button carries
// data-upload-ring so the own-bubble restyle (MessageThread OWN_BUBBLE_CONTENT)
// leaves it alone.
// Motion (docs/motion.md, upload ring): the arc fills at the real progress
// (mv-fill); on finish the ring scales to 0 (mv-ring-out) and the tile it sits
// on settles with ease-pop (uploadSettle). Never a fade.

import { useRef, type ReactElement } from 'react';
import { uploadSettle, usePresence } from '@/lib/motion';
import { ICON_SIZE, IconRotateCcw, IconX } from '@/components/ui/icons';
import { PressableRow } from '@/components/ui/PressableRow';
import { ProgressRing } from '@/components/ui/ProgressRing';
import { cn } from '@/lib/cn';

type UploadRingVariant = 'voice' | 'image' | 'file';

/** The ring's box (px) per variant, from the prototype. */
export const UPLOAD_RING_SIZES: Readonly<Record<UploadRingVariant, number>> = {
  voice: 40,
  image: 56,
  file: 44,
};

/** The drawn ring (disc, track, arc) per variant. */
const RING_CLASS: Readonly<Record<UploadRingVariant, string>> = {
  voice: 'h-10 w-10',
  image: 'h-14 w-14',
  file: 'h-11 w-11',
};

/**
 * The tap target per variant: never under 44x44 (the 40px voice ring gets a
 * 44px button). The width is the drawn ring's (PressableRow inline sizes to
 * content) with a 44px floor.
 */
const HIT_CLASS: Readonly<Record<UploadRingVariant, string>> = {
  voice: 'h-11 min-w-11',
  image: 'h-14 min-w-14',
  file: 'h-11 min-w-11',
};

const STROKE = 3;
/** The X inside the ring (px). */
export const UPLOAD_RING_STOP = ICON_SIZE.inline;
/** ProgressRing's partial arc share; unused here (unknown progress draws 0). */
const ARC = 0;

/** The spoken name of the cancel control (D4b). */
export type UploadRingLabel = 'Stop sending' | 'Stop upload' | 'Stop recording' | 'Cancel upload';

/** One grid cell for every layer: they stack without any positioning. */
const LAYER = '[grid-area:1/1]';

/** The bubble's inks for a ring drawn on a bubble fill (token classes only). */
export interface UploadRingInk {
  /** The flat disc behind the ring. */
  disc: string;
  /** The ring's track. */
  track: string;
  /** The arc and the X. */
  arc: string;
}

export function UploadRing({
  progress,
  onCancel,
  className,
  variant,
  hidden = false,
  ink,
  label = 'Stop sending',
}: {
  /** Upload progress 0..1; null while unknown (drawn at 0 until bytes move). */
  progress: number | null;
  onCancel?: (() => void) | undefined;
  /** Where it goes (the caller's position classes); never a size. */
  className?: string | undefined;
  /** Which prototype size: voice 40, image (photo, album) 56, file 44. */
  variant: UploadRingVariant;
  /** Upload done: scaled to 0 in place (mv-ring-out), not focusable. */
  hidden?: boolean;
  /** On a bubble fill: its inks in place of the overlay disc and ink. */
  ink?: UploadRingInk | undefined;
  /** The cancel control's spoken name; chat sends say "Stop sending". */
  label?: UploadRingLabel | undefined;
}): ReactElement {
  const indeterminate = progress === null;
  // Unknown progress shows an empty ring (0), then fills with the real value.
  const shown = progress ?? 0;
  const size = UPLOAD_RING_SIZES[variant];
  return (
    <>
      <PressableRow
        inline
        type="button"
        data-upload-ring=""
        data-ring-variant={variant}
        data-upload-progress={indeterminate ? 'unknown' : String(Math.round(progress * 100))}
        aria-label={label}
        aria-hidden={hidden ? true : undefined}
        tabIndex={hidden ? -1 : undefined}
        // The press never reaches the bubble (no long-press, no swipe).
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          if (!hidden) onCancel?.();
        }}
        className={cn(
          // PressableRow (not IconButton): no text-fg-2 for the own bubble's
          // [&_.text-fg-2]:opacity-80 to dim, so the ring keeps its overlay ink.
          'grid shrink-0 place-items-center',
          ink === undefined ? 'text-overlay-fg' : ink.arc,
          HIT_CLASS[variant],
          hidden && 'pointer-events-none mv-ring-out',
          className,
        )}
      >
        <span
          aria-hidden="true"
          data-upload-disc=""
          className={cn(
            LAYER,
            RING_CLASS[variant],
            'rounded-full',
            ink === undefined ? 'bg-overlay opacity-60 lit-media' : ink.disc,
          )}
        />
        <ProgressRing
          progress={shown}
          size={size}
          stroke={STROKE}
          arc={ARC}
          className={cn(LAYER, RING_CLASS[variant])}
          trackClass={ink === undefined ? 'text-overlay-dot' : ink.track}
          arcClass={ink === undefined ? 'text-overlay-fg' : ink.arc}
        />
        <IconX size={UPLOAD_RING_STOP} className={LAYER} />
      </PressableRow>
      {/* The progress for screen readers: a button's children are not read, so
          the progressbar sits beside it, sr-only (out of flow, nothing paints). */}
      {hidden ? null : (
        <span
          role="progressbar"
          aria-label="Upload progress"
          aria-valuemin={0}
          aria-valuemax={100}
          {...(indeterminate ? {} : { 'aria-valuenow': Math.round(progress * 100) })}
          className="sr-only"
        />
      )}
    </>
  );
}

/**
 * An UploadRing over a tile (photo, album) for as long as `ring` is set; when
 * the upload finishes the ring stays a moment to scale to 0 (mv-ring-out)
 * while the tile under it settles with ease-pop (uploadSettle), then goes.
 * The wrapper is display: contents, so the ring keeps the caller's place.
 */
export function TileUploadRing(props: {
  ring: { progress: number | null } | null;
  onCancel?: (() => void) | undefined;
  className?: string | undefined;
}): ReactElement | null {
  const last = useRef<number | null>(props.ring?.progress ?? null);
  if (props.ring !== null) last.current = props.ring.progress;
  const { rendered, ref, leaving } = usePresence<HTMLSpanElement>(props.ring !== null, {
    exit: (el) => uploadSettle(el.parentElement),
  });
  if (!rendered) return null;
  return (
    <span ref={ref} data-tile-upload-ring="" className="contents">
      <UploadRing
        progress={leaving ? 1 : last.current}
        onCancel={props.onCancel}
        variant="image"
        className={props.className}
        hidden={leaving}
      />
    </span>
  );
}

/**
 * A failed upload: Retry in the ring's own spot (same disc, same box, same
 * hit area), so the item never shifts between uploading and failed.
 */
export function UploadRetry({
  onRetry,
  className,
  variant,
}: {
  onRetry: () => void;
  className?: string | undefined;
  variant: UploadRingVariant;
}): ReactElement {
  return (
    <PressableRow
      inline
      type="button"
      data-upload-retry=""
      data-ring-variant={variant}
      aria-label="Retry"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onRetry();
      }}
      className={cn(
        'grid shrink-0 place-items-center text-overlay-fg',
        HIT_CLASS[variant],
        className,
      )}
    >
      <span
        aria-hidden="true"
        data-upload-disc=""
        className={cn(LAYER, RING_CLASS[variant], 'rounded-full bg-overlay opacity-60 lit-media')}
      />
      <IconRotateCcw size={UPLOAD_RING_STOP} className={LAYER} />
    </PressableRow>
  );
}

const MB = 1024 * 1024;

function mb(bytes: number): string {
  const v = bytes / MB;
  return v >= 10 ? String(Math.round(v)) : (Math.round(v * 10) / 10).toFixed(1);
}

/**
 * The size progress meta for an uploading item: "1.2 of 3.4 MB" (from bytes;
 * never a % figure). Under 0.1 MB in total it reads in KB. Pure.
 */
export function uploadSizeMeta(loaded: number, total: number): string {
  const done = Math.max(0, Math.min(loaded, total));
  if (total < MB / 10) {
    return `${Math.round(done / 1024)} of ${Math.max(1, Math.round(total / 1024))} KB`;
  }
  return `${mb(done)} of ${mb(total)} MB`;
}
