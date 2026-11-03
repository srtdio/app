// Content landing after loading boxes (docs/motion.md, sweepBoxes): when the
// real rows replace the Bone boxes, the first rows settle 6 px, 200 ms, 40 ms
// stagger (max 5). Never on a paint that had no boxes (kept views, device
// cache, a saved list): those paint still. The wrapper is display: contents,
// so it adds no box and shifts nothing.
import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { settle, useHadBoxes } from '@/lib/motion';

interface SettleLandingProps {
  /** True while the boxes show. */
  boxes: boolean;
  /** The rows that settle (default: the wrapper's direct children). */
  selector?: string;
  children?: ReactNode;
}

export function SettleLanding({ boxes, selector, children }: SettleLandingProps) {
  const ref = useRef<HTMLDivElement>(null);
  const hadBoxes = useHadBoxes(boxes);
  const done = useRef(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (done.current || boxes || !hadBoxes || el === null) return;
    done.current = true;
    settle(selector !== undefined ? el.querySelectorAll(selector) : el.children);
  }, [boxes, hadBoxes, selector]);
  return (
    <div ref={ref} data-settle-landing="" className="contents">
      {children}
    </div>
  );
}
