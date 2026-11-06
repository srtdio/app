import type { ButtonHTMLAttributes, Ref } from 'react';
import { cn } from '@/lib/cn';

interface DropZoneProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Minimum height of the target; defaults to the 44px touch minimum. */
  minHeight?: 'touch' | 'tile' | 'panel';
  /** Ref to the rendered <button>; a plain prop so DropZone stays a callable function. */
  buttonRef?: Ref<HTMLButtonElement> | undefined;
}

const MIN_HEIGHT: Record<NonNullable<DropZoneProps['minHeight']>, string> = {
  touch: 'min-h-11',
  tile: 'min-h-32',
  panel: 'min-h-40',
};

// The dashed upload target: a tappable surface (drag and drop handlers pass
// through) with a strong dashed border on panel-2, a centred column of
// content, a focus-visible ring and a disabled fade. Press (motion move 5):
// mv-press (MOVE_CLASS.press) sinks it to .97 while held and eases colours.
const DROP_ZONE_BASE =
  'flex w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border-strong bg-panel-2 lit-well-soft p-4 text-center text-fg-2 mv-press hover:text-fg focus-visible:lit-focus disabled:text-fg-3 disabled:pointer-events-none disabled:cursor-default';

export function DropZone({
  minHeight = 'touch',
  className,
  buttonRef,
  type = 'button',
  ...props
}: DropZoneProps) {
  return (
    <button
      ref={buttonRef}
      type={type}
      className={cn(DROP_ZONE_BASE, MIN_HEIGHT[minHeight], className)}
      {...props}
    />
  );
}
