import type { ButtonHTMLAttributes, Ref } from 'react';
import { cn } from '@/lib/cn';

export interface PressableRowProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Ref to the rendered <button>; a plain prop so PressableRow stays a callable function. */
  buttonRef?: Ref<HTMLButtonElement>;
}

// The tappable-surface primitive: list rows, menu rows, tiles, cards and
// calendar cells. Full width, at least 44 tall, 8px radius, left aligned, a
// panel-2 hover, a focus-visible ring and a disabled fade. No other visual
// classes: callers add layout (flex, gap, padding) and colour through className.
export const PRESSABLE_ROW_BASE =
  'w-full min-h-[44px] rounded-lg text-left hover:bg-panel-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50 disabled:pointer-events-none';

export function PressableRow({
  className,
  buttonRef,
  type = 'button',
  ...props
}: PressableRowProps) {
  return (
    <button ref={buttonRef} type={type} className={cn(PRESSABLE_ROW_BASE, className)} {...props} />
  );
}
