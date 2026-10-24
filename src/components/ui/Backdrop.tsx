import { useEffect, useState } from 'react';
import { cn } from '@/lib/cn';

export interface BackdropProps {
  /** Names what a tap does, e.g. "Close actions". */
  'aria-label': string;
  onClick: () => void;
  /** 'fixed' covers the viewport; 'absolute' covers the nearest positioned parent. */
  position?: 'absolute' | 'fixed';
  /** Extra layout classes (z-index). No colour or hover classes: every dim is the one scrim. */
  className?: string;
}

// The one dim layer behind sheets and menus. A tappable button that closes
// what sits above it; bg-scrim in both themes, no hover change, and a short
// fade in on mount that reduced motion turns off. Full-screen media viewers
// use bg-overlay and are not backdrops.
export const BACKDROP_BASE =
  'inset-0 bg-scrim cursor-default transition-opacity duration-fast motion-reduce:transition-none focus:outline-none';

export function Backdrop({
  'aria-label': ariaLabel,
  onClick,
  position = 'fixed',
  className,
}: BackdropProps) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onClick}
      data-backdrop=""
      className={cn(position, BACKDROP_BASE, shown ? 'opacity-100' : 'opacity-0', className)}
    />
  );
}
