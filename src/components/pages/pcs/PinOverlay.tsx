import type { ReactElement } from 'react';
import {
  CheckpointCircle,
  type CheckpointCircleSize,
} from '@/components/comments/CheckpointCircle';
import { pinName, type PinDot } from '@/components/pages/pcs/pin-annotations';
import { IconButton } from '@/components/ui/IconButton';

// Pin overlay: the pins layered over one lightbox slide. It renders into the
// seam the lightbox leaves (a pointer-events-none absolute layer), so each pin
// re-enables pointer events and is a real, keyboard-operable button with a
// 44x44 hit target. The marker is the checkpoint circle (ink ring with the
// checkpoint's number, good once resolved, as the list draws it); a pin on a
// plain comment is the ink dot with no number. Ink and good are theme tokens,
// so light and dark flip together.

/** One pin's marker: the checkpoint circle in the given size. Pure. */
export function pinMarker(pin: PinDot, size: CheckpointCircleSize = 'marker'): ReactElement {
  return pin.n === null ? (
    <CheckpointCircle state="pin" size={size} />
  ) : (
    <CheckpointCircle n={pin.n} state={pin.state} size={size} />
  );
}

interface PinOverlayProps {
  pins: PinDot[];
  onPinClick: (commentId: string) => void;
}

export function PinOverlay({ pins, onPinClick }: PinOverlayProps): ReactElement {
  // Defensive: never position a pin off the image even if a bad coord slips in.
  const visible = pins.filter((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1);

  return (
    <div className="absolute inset-0">
      {visible.map((pin) => (
        <IconButton
          key={pin.annotationId}
          type="button"
          label={pinName(pin)}
          data-pin-state={pin.state}
          onClick={() => onPinClick(pin.commentId)}
          style={{ left: `${pin.x * 100}%`, top: `${pin.y * 100}%` }}
          className="pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 focus-visible:lit-focus"
        >
          {pinMarker(pin)}
        </IconButton>
      ))}
    </div>
  );
}
