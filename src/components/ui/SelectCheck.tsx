import type { HTMLAttributes } from 'react';
import { IconCheck, ICON_SIZE } from '@/components/ui/icons';
import { cn } from '@/lib/cn';

/** md: the 24 circle beside a row; sm: the 20 badge on a list card picture corner. */
export type SelectCheckSize = 'md' | 'sm';

interface SelectCheckProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  checked: boolean;
  /** The circle's box. Fill, border and tick are the same at every size. */
  size?: SelectCheckSize;
}

const SIZE_CLASS: Readonly<Record<SelectCheckSize, string>> = {
  md: 'h-6 w-6',
  sm: 'h-5 w-5',
};

/** Classes for the selection circle, on or off. The one select circle in the app. */
export function selectCheckClass(checked: boolean, size: SelectCheckSize = 'md'): string {
  return cn(
    'flex shrink-0 items-center justify-center rounded-full border mv-tint',
    SIZE_CLASS[size],
    checked ? 'border-transparent bg-accent text-accent-fg' : 'border-border-strong bg-panel',
  );
}

/**
 * The select circle used by every multi-select surface (list cards, chat rows,
 * messages, the pickers, palette pick mode). Decorative: the surrounding
 * control carries the state. `className` is a placement slot only (position,
 * scale-in); it never restyles the fill, border or tick.
 */
export function SelectCheck({ checked, size = 'md', className, ...rest }: SelectCheckProps) {
  return (
    <span
      aria-hidden="true"
      data-select-check={checked ? 'on' : 'off'}
      {...rest}
      className={cn(selectCheckClass(checked, size), className)}
    >
      {checked ? <IconCheck size={ICON_SIZE.inline} /> : null}
    </span>
  );
}
