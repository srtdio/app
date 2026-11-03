// A strip above (or at the top of) the composer: the reply quote, the mention
// and hashtag pickers. Motion (docs/motion.md, edgeStrip above the composer): it
// slides up 8-48 px on Y as it appears and back down the same way as it goes,
// never a fade. One already there when the composer first paints (a kept
// reply draft on chat open) stays still. While it leaves it shows what it
// last held and takes no taps.
import { useEffect, useRef, type HTMLAttributes, type ReactElement, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { stripIn, stripOut, usePresence } from '@/lib/motion';

export function ComposerStrip({
  open,
  distance = 16,
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement> & {
  open: boolean;
  /** How far it slides on Y (px, the 8-48 band). */
  distance?: number;
  children?: ReactNode;
}): ReactElement | null {
  const last = useRef<ReactNode>(children);
  if (open) last.current = children;
  // True until the first paint is done: a strip open from the start stays still.
  const firstPaint = useRef(true);
  useEffect(() => {
    firstPaint.current = false;
  }, []);
  const { rendered, ref, leaving } = usePresence<HTMLDivElement>(open, {
    enter: (el) => (firstPaint.current ? undefined : stripIn(el, 'above-composer', distance)),
    exit: (el) => stripOut(el, 'above-composer', distance),
  });
  if (!rendered) return null;
  return (
    <div
      ref={ref}
      {...rest}
      {...(leaving ? { 'aria-hidden': true } : {})}
      className={cn(className, leaving && 'pointer-events-none')}
    >
      {open ? children : last.current}
    </div>
  );
}
