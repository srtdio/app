import type { ButtonHTMLAttributes, Ref } from 'react';
import { cn } from '@/lib/cn';

interface PressableRowProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Ref to the rendered <button>; a plain prop so PressableRow stays a callable function. */
  buttonRef?: Ref<HTMLButtonElement> | undefined;
  /** Shrink to content (w-auto) for inline edit triggers instead of filling the row. */
  inline?: boolean;
  /** Square corners (rounded-none) for surfaces that sit flush, like a quote rule. */
  flat?: boolean;
  /** Card corners (rounded-xl, the 12px card role) for a tappable card. */
  card?: boolean;
  /** Text alignment; rows are left aligned by default. */
  align?: 'left' | 'center';
  /**
   * 22 tall instead of 44: the laptop Plan month's item lines only (a mouse
   * surface; the CLAUDE.md exception, guarded in ui-rules.test.ts).
   */
  dense?: boolean;
}

// The tappable-surface primitive: list rows, menu rows, tiles, cards and
// calendar cells. Full width, at least 44 tall (22 when dense), 8px radius,
// left aligned, a panel-2 hover, a focus-visible ring and a disabled fade. No
// other visual classes: callers add layout (flex, gap, padding) and colour
// through className, and change width, radius, alignment or height only through
// the props above.
const PRESSABLE_ROW_LOOK =
  'hover:bg-panel-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50 disabled:pointer-events-none';
export const PRESSABLE_ROW_BASE = `min-h-[44px] ${PRESSABLE_ROW_LOOK}`;
const PRESSABLE_ROW_DENSE = `min-h-[22px] ${PRESSABLE_ROW_LOOK}`;

export function PressableRow({
  className,
  buttonRef,
  inline = false,
  flat = false,
  card = false,
  align = 'left',
  dense = false,
  type = 'button',
  ...props
}: PressableRowProps) {
  return (
    <button
      ref={buttonRef}
      type={type}
      className={cn(
        dense ? PRESSABLE_ROW_DENSE : PRESSABLE_ROW_BASE,
        inline ? 'w-auto' : 'w-full',
        flat ? 'rounded-none' : card ? 'rounded-xl' : 'rounded-lg',
        align === 'center' ? 'text-center' : 'text-left',
        className,
      )}
      {...props}
    />
  );
}
