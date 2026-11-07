// The WhatsApp upload control on an uploading photo, album, file or voice
// note: a 16px X on a dark translucent disc, with a ring around it that fills
// with the upload's progress (a light arc on a translucent track). Tapping it
// cancels the send (no confirm). While progress is unknown (queued, waiting,
// backoff, offline) the ring is a partial arc that turns (mv-spin); with
// reduced motion it stays still.
//
// It never positions itself: the caller does (absolutely centred in the voice
// play slot or over an image, in flow in the file icon spot). Its layers stack
// in one grid cell, so nothing inside needs a positioned ancestor either.
// Sizes follow the approved prototype: voice 40, photo and album 56, file 44;
// the button is never under 44x44 (the voice ring sits in a 44px button).
//
// Over a photo it draws on the overlay tokens (a dark disc, light ink, the same
// values in light and dark). In the voice play slot the caller hands the
// bubble's own inks instead (`ink`: a flat disc, a track and the arc and X in
// the play glyph's ink), with no shadow, so nothing paints past the slot. The button carries data-upload-ring so
// the own-bubble restyle (MessageThread OWN_BUBBLE_CONTENT) leaves it alone.
// Motion (docs/motion.md, upload ring): the arc fills at the real progress
// (mv-fill); on finish the ring scales to 0 (mv-ring-out) and the tile it sits
// on settles with ease-pop (uploadSettle). Never a fade.

import { useRef, type ReactElement } from 'react';
import { uploadSettle, usePresence } from '@/lib/motion';
import { ICON_SIZE, IconX } from '@/components/ui/icons';
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
export const UPLOAD_RING_X = ICON_SIZE.inline;
/** The indeterminate arc's share of the ring. */
const ARC = 0.25;

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
}: {
  /** Upload progress 0..1; null while unknown (the arc pulses). */
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
}): ReactElement {
  const indeterminate = progress === null;
  const size = UPLOAD_RING_SIZES[variant];
  return (
    <>
      <PressableRow
        inline
        type="button"
        data-upload-ring=""
        data-ring-variant={variant}
        data-upload-progress={indeterminate ? 'unknown' : String(Math.round(progress * 100))}
        aria-label="Cancel upload"
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
          progress={progress}
          size={size}
          stroke={STROKE}
          arc={ARC}
          className={cn(LAYER, RING_CLASS[variant], indeterminate && 'mv-spin')}
          trackClass={ink === undefined ? 'text-overlay-dot' : ink.track}
          arcClass={ink === undefined ? 'text-overlay-fg' : ink.arc}
        />
        <IconX size={ICON_SIZE.inline} className={LAYER} />
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
