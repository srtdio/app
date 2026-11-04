import type { ButtonHTMLAttributes, Ref } from 'react';
import { cn } from '@/lib/cn';
import { MOVE_CLASS } from '@/lib/motion';

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
  /**
   * Draw the focus line inside the edge (lit-focus-inset) so an overflow-hidden
   * card or a flush tile does not clip it.
   */
  insetFocus?: boolean;
}

// The tappable-surface primitive: list rows, menu rows, tiles, cards and
// calendar cells. Full width, at least 44 tall (22 when dense), 8px radius,
// left aligned, the lit-hover overlay (hover and press keep the light), a
// focus-visible line and a solid fg-3 disabled look (never a fade). No other
// visual classes: callers add layout (flex, gap, padding) and colour through
// className, and change width, radius, alignment, height or focus placement
// only through the props above. Press (motion move 5): MOVE_CLASS.press sinks
// the row to .97 while held (120 ms).
const FOCUS = 'focus-visible:lit-focus';
const FOCUS_INSET = 'focus-visible:lit-focus-inset';
const PRESSABLE_ROW_LOOK = `${MOVE_CLASS.press} lit-hover ${FOCUS} disabled:text-fg-3 disabled:pointer-events-none disabled:cursor-default`;
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
  insetFocus = false,
  type = 'button',
  ...props
}: PressableRowProps) {
  const base = dense ? PRESSABLE_ROW_DENSE : PRESSABLE_ROW_BASE;
  return (
    <button
      ref={buttonRef}
      type={type}
      className={cn(
        insetFocus ? base.replace(FOCUS, FOCUS_INSET) : base,
        inline ? 'w-auto' : 'w-full',
        flat ? 'rounded-none' : card ? 'rounded-xl' : 'rounded-lg',
        align === 'center' ? 'text-center' : 'text-left',
        className,
      )}
      {...props}
    />
  );
}
