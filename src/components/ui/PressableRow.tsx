import type { ButtonHTMLAttributes, Ref } from 'react';
import { cn } from '@/lib/cn';

export interface PressableRowProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Ref to the rendered <button>; a plain prop so PressableRow stays a callable function. */
  buttonRef?: Ref<HTMLButtonElement> | undefined;
  /** Shrink to content (w-auto) for inline edit triggers instead of filling the row. */
  inline?: boolean;
  /** Square corners (rounded-none) for surfaces that sit flush, like a quote rule. */
  flat?: boolean;
  /** Text alignment; rows are left aligned by default. */
  align?: 'left' | 'center';
}

// The tappable-surface primitive: list rows, menu rows, tiles, cards and
// calendar cells. Full width, at least 44 tall, 8px radius, left aligned, a
// panel-2 hover, a focus-visible ring and a disabled fade. No other visual
// classes: callers add layout (flex, gap, padding) and colour through className,
// and change width, radius or alignment only through the props above.
export const PRESSABLE_ROW_BASE =
  'min-h-[44px] hover:bg-panel-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50 disabled:pointer-events-none';

export function PressableRow({
  className,
  buttonRef,
  inline = false,
  flat = false,
  align = 'left',
  type = 'button',
  ...props
}: PressableRowProps) {
  return (
    <button
      ref={buttonRef}
      type={type}
      className={cn(
        PRESSABLE_ROW_BASE,
        inline ? 'w-auto' : 'w-full',
        flat ? 'rounded-none' : 'rounded-lg',
        align === 'center' ? 'text-center' : 'text-left',
        className,
      )}
      {...props}
    />
  );
}
