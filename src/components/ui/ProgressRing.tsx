// A circular progress ring: a track circle and an arc that fills with
// progress, drawn from the top (rotated -90deg) in currentColor strokes. The
// caller sets the drawn box (sizeClass) and the inks (trackClass, arcClass,
// token classes only, so light and dark stay at parity). Progress null draws
// a partial arc of `arc` (the caller pulses it). Only the arc's stroke offset
// ever changes. Used by chat/UploadRing.

import type { ReactElement } from 'react';
import { cn } from '@/lib/cn';

/** The ring's circumference for a box of `size` px and a stroke of `stroke` px. Pure. */
export function ringCircumference(size: number, stroke: number): number {
  return 2 * Math.PI * ((size - stroke) / 2);
}

/** The stroke offset for a progress 0..1 (null: the partial `arc`). Pure. */
export function ringDashOffset(
  progress: number | null,
  size: number,
  stroke: number,
  arc: number,
): number {
  const shown = progress === null ? arc : Math.min(Math.max(progress, 0), 1);
  return ringCircumference(size, stroke) * (1 - shown);
}

export function ProgressRing(props: {
  /** Progress 0..1; null while unknown (the partial arc). */
  progress: number | null;
  /** The viewBox size (px). */
  size: number;
  /** Stroke width (px, viewBox units). */
  stroke: number;
  /** The partial arc's share of the ring while progress is null. */
  arc: number;
  /** Extra classes on the svg (box size, grid area). */
  className?: string | undefined;
  /** The track circle's ink. */
  trackClass: string;
  /** The arc's ink and motion. */
  arcClass: string;
}): ReactElement {
  const { size, stroke } = props;
  const radius = (size - stroke) / 2;
  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${size} ${size}`}
      className={cn(props.className, '-rotate-90')}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={stroke}
        className={props.trackClass}
      />
      <circle
        data-upload-arc=""
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={ringCircumference(size, stroke)}
        strokeDashoffset={ringDashOffset(props.progress, size, stroke, props.arc)}
        className={props.arcClass}
      />
    </svg>
  );
}
