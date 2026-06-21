// Avatar cropper for the onboarding profile screen. Ports an already-approved
// prototype: the photo always covers a square FRAME (260 on-screen px); zoom is
// one-directional from baseScale (photo just fills the frame) up to baseScale*3,
// so there are never empty gaps. The export is a SQUARE 512px PNG; the circular
// crop is only a display guide (the Avatar component renders the final circle).
//
// All geometry (image, scale, offsets) lives in refs so the pointer handlers read
// live values without stale closures; React state carries only what the UI needs
// to re-render (whether a photo is loaded, and the slider value).

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';

const FRAME = 260;
const EXPORT = 512;

export interface AvatarCropperHandle {
  /** Whether a photo has been chosen and loaded. */
  hasPhoto: () => boolean;
  /** Produce the cropped 512x512 PNG, or null when no photo is loaded. */
  exportPng: () => Promise<File | null>;
}

interface AvatarCropperProps {
  /** Notified when a photo loads, with its object URL for the live previews. */
  onPhotoChange?: (info: { hasPhoto: boolean; previewUrl: string | null }) => void;
}

interface Point {
  x: number;
  y: number;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Draw the positioned image into a square of side S (r scales FRAME coords up). */
function drawCrop(
  ctx: CanvasRenderingContext2D,
  S: number,
  img: HTMLImageElement,
  scale: number,
  offX: number,
  offY: number,
): void {
  const r = S / FRAME;
  ctx.clearRect(0, 0, S, S);
  ctx.drawImage(img, offX * r, offY * r, img.width * scale * r, img.height * scale * r);
}

function AvatarCropperImpl(
  { onPhotoChange }: AvatarCropperProps,
  ref: React.Ref<AvatarCropperHandle>,
): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const imgRef = useRef<HTMLImageElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const baseScaleRef = useRef(1);
  const scaleRef = useRef(1);
  const offXRef = useRef(0);
  const offYRef = useRef(0);

  const pointers = useRef<Map<number, Point>>(new Map());
  const pinchDist0 = useRef(0);
  const pinchScale0 = useRef(1);

  const [hasPhoto, setHasPhoto] = useState(false);
  const [sliderValue, setSliderValue] = useState(1);

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = imgRef.current;
    if (!img) {
      ctx.clearRect(0, 0, FRAME, FRAME);
      return;
    }
    drawCrop(ctx, FRAME, img, scaleRef.current, offXRef.current, offYRef.current);
  }, []);

  // Keep the image covering the frame: never let an edge pull inside it.
  const clamp = useCallback(() => {
    const img = imgRef.current;
    if (!img) return;
    const dw = img.width * scaleRef.current;
    const dh = img.height * scaleRef.current;
    offXRef.current = Math.min(0, Math.max(FRAME - dw, offXRef.current));
    offYRef.current = Math.min(0, Math.max(FRAME - dh, offYRef.current));
  }, []);

  // Zoom to newScale (floored at baseScale, capped at baseScale*3) while keeping
  // the image point under (cx, cy) fixed; sync the slider and re-clamp.
  const setScaleAround = useCallback(
    (newScale: number, cx: number, cy: number) => {
      const img = imgRef.current;
      if (!img) return;
      const base = baseScaleRef.current;
      const next = Math.min(base * 3, Math.max(base, newScale));
      const ix = (cx - offXRef.current) / scaleRef.current;
      const iy = (cy - offYRef.current) / scaleRef.current;
      scaleRef.current = next;
      offXRef.current = cx - ix * next;
      offYRef.current = cy - iy * next;
      setSliderValue(next / base);
      clamp();
      render();
    },
    [clamp, render],
  );

  const onPhotoChosen = useCallback(
    (file: File) => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      const url = URL.createObjectURL(file);
      urlRef.current = url;
      const img = new Image();
      img.onload = () => {
        const base = Math.max(FRAME / img.width, FRAME / img.height);
        baseScaleRef.current = base;
        scaleRef.current = base;
        offXRef.current = (FRAME - img.width * base) / 2;
        offYRef.current = (FRAME - img.height * base) / 2;
        imgRef.current = img;
        setSliderValue(1);
        setHasPhoto(true);
        clamp();
        render();
        onPhotoChange?.({ hasPhoto: true, previewUrl: url });
      };
      img.src = url;
    },
    [clamp, render, onPhotoChange],
  );

  useImperativeHandle(
    ref,
    () => ({
      hasPhoto: () => imgRef.current !== null,
      exportPng: () =>
        new Promise<File | null>((resolve) => {
          const img = imgRef.current;
          if (!img) {
            resolve(null);
            return;
          }
          const canvas = document.createElement('canvas');
          canvas.width = EXPORT;
          canvas.height = EXPORT;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            resolve(null);
            return;
          }
          drawCrop(ctx, EXPORT, img, scaleRef.current, offXRef.current, offYRef.current);
          canvas.toBlob((blob) => {
            if (!blob) {
              resolve(null);
              return;
            }
            resolve(new File([blob], 'avatar.png', { type: 'image/png' }));
          }, 'image/png');
        }),
    }),
    [],
  );

  // Revoke the last object URL on unmount so a chosen photo never leaks.
  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  // Wheel zoom for desktop. Attached manually so preventDefault is honoured (a
  // React onWheel listener is passive and cannot block the page scroll).
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      if (!imgRef.current) return;
      event.preventDefault();
      const rect = stage.getBoundingClientRect();
      const x = (event.clientX - rect.left) * (FRAME / rect.width);
      const y = (event.clientY - rect.top) * (FRAME / rect.height);
      const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
      setScaleAround(scaleRef.current * factor, x, y);
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [setScaleAround]);

  function toFrame(event: React.PointerEvent): Point {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: (event.clientX - rect.left) * (FRAME / rect.width),
      y: (event.clientY - rect.top) * (FRAME / rect.height),
    };
  }

  function handlePointerDown(event: React.PointerEvent): void {
    if (!imgRef.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, toFrame(event));
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      if (a && b) {
        pinchDist0.current = distance(a, b);
        pinchScale0.current = scaleRef.current;
      }
    }
  }

  function handlePointerMove(event: React.PointerEvent): void {
    if (!imgRef.current) return;
    const prev = pointers.current.get(event.pointerId);
    if (!prev) return;
    const point = toFrame(event);
    pointers.current.set(event.pointerId, point);

    if (pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      if (a && b && pinchDist0.current > 0) {
        const dist = distance(a, b);
        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2;
        setScaleAround(pinchScale0.current * (dist / pinchDist0.current), midX, midY);
      }
      return;
    }

    // Single pointer: drag by the delta in FRAME coords.
    offXRef.current += point.x - prev.x;
    offYRef.current += point.y - prev.y;
    clamp();
    render();
  }

  function handlePointerUp(event: React.PointerEvent): void {
    pointers.current.delete(event.pointerId);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Capture may already be released; ignore.
    }
    // If one pointer remains, drag resumes from its stored position on the next
    // move (deltas are computed against that position), so there is no jump.
  }

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    if (file) onPhotoChosen(file);
    // Reset so choosing the same file again still fires a change event.
    event.target.value = '';
  }

  function stepZoom(delta: number): void {
    setScaleAround(
      baseScaleRef.current * (scaleRef.current / baseScaleRef.current + delta),
      FRAME / 2,
      FRAME / 2,
    );
  }

  return (
    <div className="flex flex-col items-center gap-3">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFileChange}
      />

      <div
        ref={stageRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        style={{ width: FRAME, height: FRAME, touchAction: 'none' }}
        className="relative overflow-hidden rounded-md border border-border bg-panel-2"
      >
        <canvas
          ref={canvasRef}
          width={FRAME}
          height={FRAME}
          style={{ width: FRAME, height: FRAME }}
        />
        {/* Circular crop guide: a ring using the accent-line token. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-full border-2 border-accent-line"
        />
        {!hasPhoto ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center px-6 text-center text-xs text-fg-3">
            Choose a photo to position it inside the circle
          </div>
        ) : null}
      </div>

      <Button
        type="button"
        variant="default"
        size="lg"
        onClick={() => fileInputRef.current?.click()}
      >
        Choose photo
      </Button>

      <div className="w-full max-w-[260px]">
        <span className="mb-1 block text-xs font-medium text-fg-2">Zoom</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Zoom out"
            onClick={() => stepZoom(-0.25)}
            disabled={!hasPhoto}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-md border border-border bg-panel-2 text-fg hover:bg-panel-3 disabled:opacity-50"
          >
            <span className="text-lg leading-none">-</span>
          </button>
          <input
            type="range"
            min={1}
            max={3}
            step={0.01}
            value={sliderValue}
            disabled={!hasPhoto}
            aria-label="Zoom"
            onChange={(event) =>
              setScaleAround(
                baseScaleRef.current * parseFloat(event.target.value),
                FRAME / 2,
                FRAME / 2,
              )
            }
            className="h-11 flex-1 accent-accent disabled:opacity-50"
          />
          <button
            type="button"
            aria-label="Zoom in"
            onClick={() => stepZoom(0.25)}
            disabled={!hasPhoto}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-md border border-border bg-panel-2 text-fg hover:bg-panel-3 disabled:opacity-50"
          >
            <span className="text-lg leading-none">+</span>
          </button>
        </div>
      </div>

      {hasPhoto ? (
        <p className="text-[11px] text-fg-3">Drag to move, pinch / slider / -/+ to zoom</p>
      ) : null}
    </div>
  );
}

export const AvatarCropper = forwardRef<AvatarCropperHandle, AvatarCropperProps>(AvatarCropperImpl);
