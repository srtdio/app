import { forwardRef } from 'react';
import { cn } from '@/lib/cn';

interface BackdropProps {
  /** Names what a tap does, e.g. "Close actions". */
  'aria-label': string;
  onClick: () => void;
  /** 'fixed' covers the viewport; 'absolute' covers the nearest positioned parent. */
  position?: 'absolute' | 'fixed';
  /** Extra layout classes (z-index). No colour or hover classes: every dim is the one scrim. */
  className?: string;
}

// The one dim layer behind sheets and menus. A tappable button that closes
// what sits above it; bg-scrim in both themes, no hover change. It renders at
// its full dim from the first frame and never fades on a timer of its own
// (docs/motion.md, never fade): when a sheet sits on it, the sheet drives its
// dim per frame from its position (trackDim / dimFor via the forwarded ref).
// Full-screen media viewers use bg-overlay and are not backdrops.
const BACKDROP_BASE = 'inset-0 bg-scrim cursor-default focus:outline-none';

export const Backdrop = forwardRef<HTMLButtonElement, BackdropProps>(function Backdrop(
  { 'aria-label': ariaLabel, onClick, position = 'fixed', className },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={ariaLabel}
      onClick={onClick}
      data-backdrop=""
      className={cn(position, BACKDROP_BASE, className)}
    />
  );
});
