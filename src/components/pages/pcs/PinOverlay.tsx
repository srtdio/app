import type { ReactElement } from 'react';
import type { PinDot } from '@/components/pages/pcs/pin-annotations';

// F5 pin overlay: numbered dots layered over one lightbox slide. It renders into
// the seam F2 left in the lightbox (a pointer-events-none absolute layer), so each
// dot re-enables pointer events and is a real, keyboard-operable button with a
// >=44x44 hit target. Colour comes only from the F1 annotation tokens, so the
// dots flip correctly in light and dark.

interface PinOverlayProps {
  pins: PinDot[];
  onPinClick: (commentId: string) => void;
}

export function PinOverlay({ pins, onPinClick }: PinOverlayProps): ReactElement {
  // Defensive: never position a dot off the image even if a bad coord slips in.
  const visible = pins.filter((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1);

  return (
    <div className="absolute inset-0">
      {visible.map((pin) => (
        <button
          key={pin.annotationId}
          type="button"
          aria-label={`Pin ${pin.n}`}
          onClick={() => onPinClick(pin.commentId)}
          style={{ left: `${pin.x * 100}%`, top: `${pin.y * 100}%` }}
          className="pointer-events-auto absolute flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-annotation-line"
        >
          <span className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-annotation-line bg-annotation-bg text-[11px] font-semibold tabular-nums text-fg shadow">
            {pin.n}
          </span>
        </button>
      ))}
    </div>
  );
}
