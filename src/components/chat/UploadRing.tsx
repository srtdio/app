// The WhatsApp upload control on an uploading photo, album, file or voice
// note: a 16px X on a dark translucent disc, with a ring around it that fills
// with the upload's progress (a light arc on a translucent track). Tapping it
// cancels the send (no confirm). While progress is unknown (queued, waiting,
// backoff, offline) the ring is a partial arc that pulses; with reduced motion
// it stays still.
//
// It never positions itself: the caller does (absolutely centred in the voice
// play slot or over an image, in flow in the file icon spot). Its layers stack
// in one grid cell, so nothing inside needs a positioned ancestor either.
// Sizes follow the approved prototype: voice 40, photo and album 56, file 44;
// the button is never under 44x44 (the voice ring sits in a 44px button).
//
// It draws on the overlay tokens (a dark disc, light ink, the same values in
// light and dark), so it reads the same over a photo, on the own bubble's fill
// and on a peer bubble, in both themes. The button carries data-upload-ring so
// the own-bubble restyle (MessageThread OWN_BUBBLE_CONTENT) leaves it alone.
// Only opacity and the ring's stroke ever change.

import type { ReactElement } from 'react';
import { ICON_SIZE, IconX } from '@/components/ui/icons';
import { cn } from '@/lib/cn';

export type UploadRingVariant = 'voice' | 'image' | 'file';

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

/** The tap target per variant: never under 44x44 (the 40px voice ring gets a 44px button). */
const HIT_CLASS: Readonly<Record<UploadRingVariant, string>> = {
  voice: 'h-11 w-11',
  image: 'h-14 w-14',
  file: 'h-11 w-11',
};

const STROKE = 3;
/** The X inside the ring (px). */
export const UPLOAD_RING_X = ICON_SIZE.inline;
/** The indeterminate arc's share of the ring. */
const ARC = 0.25;

function circumference(size: number): number {
  return 2 * Math.PI * ((size - STROKE) / 2);
}

/** The stroke offset for a progress 0..1 (null: the indeterminate arc). Pure. */
export function ringDashOffset(
  progress: number | null,
  size: number = UPLOAD_RING_SIZES.image,
): number {
  const shown = progress === null ? ARC : Math.min(Math.max(progress, 0), 1);
  return circumference(size) * (1 - shown);
}

/** One grid cell for every layer: they stack without any positioning. */
const LAYER = '[grid-area:1/1]';

export function UploadRing({
  progress,
  onCancel,
  className,
  variant,
  hidden = false,
}: {
  /** Upload progress 0..1; null while unknown (the arc pulses). */
  progress: number | null;
  onCancel?: (() => void) | undefined;
  /** Where it goes (the caller's position classes); never a size. */
  className?: string | undefined;
  /** Which prototype size: voice 40, image (photo, album) 56, file 44. */
  variant: UploadRingVariant;
  /** Faded out (upload done): kept in place for the crossfade, not focusable. */
  hidden?: boolean;
}): ReactElement {
  const indeterminate = progress === null;
  const size = UPLOAD_RING_SIZES[variant];
  const radius = (size - STROKE) / 2;
  return (
    <button
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
        'grid shrink-0 place-items-center rounded-full text-overlay-fg',
        HIT_CLASS[variant],
        'transition-[opacity,visibility] duration-150 motion-reduce:transition-none',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-overlay-fg',
        hidden ? 'pointer-events-none invisible opacity-0' : 'visible opacity-100',
        className,
      )}
    >
      <span
        aria-hidden="true"
        data-upload-disc=""
        className={cn(LAYER, RING_CLASS[variant], 'rounded-full bg-overlay opacity-60')}
      />
      <svg
        aria-hidden="true"
        viewBox={`0 0 ${size} ${size}`}
        className={cn(LAYER, RING_CLASS[variant], '-rotate-90')}
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={STROKE}
          className="text-overlay-dot"
        />
        <circle
          data-upload-arc=""
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={circumference(size)}
          strokeDashoffset={ringDashOffset(progress, size)}
          className={cn(
            'text-overlay-fg transition-[stroke-dashoffset] duration-150 motion-reduce:transition-none',
            indeterminate && 'animate-pulse motion-reduce:animate-none',
          )}
        />
      </svg>
      <IconX size={UPLOAD_RING_X} className={LAYER} />
    </button>
  );
}
