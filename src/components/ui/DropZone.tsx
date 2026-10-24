import type { ButtonHTMLAttributes, Ref } from 'react';
import { cn } from '@/lib/cn';

export interface DropZoneProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Minimum height of the target; defaults to the 44px touch minimum. */
  minHeight?: 'touch' | 'tile' | 'panel';
  /** Ref to the rendered <button>; a plain prop so DropZone stays a callable function. */
  buttonRef?: Ref<HTMLButtonElement> | undefined;
}

const MIN_HEIGHT: Record<NonNullable<DropZoneProps['minHeight']>, string> = {
  touch: 'min-h-[44px]',
  tile: 'min-h-[120px]',
  panel: 'min-h-[160px]',
};

// The dashed upload target: a tappable surface (drag and drop handlers pass
// through) with a strong dashed border on panel-2, a centred column of
// content, a focus-visible ring and a disabled fade.
export const DROP_ZONE_BASE =
  'flex w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border-strong bg-panel-2 p-4 text-center text-fg-2 transition-colors hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50 disabled:pointer-events-none';

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
