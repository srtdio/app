import { IconCheck, ICON_SIZE } from '@/components/ui/icons';
import { cn } from '@/lib/cn';

interface SelectCheckProps {
  checked: boolean;
}

/** Classes for the 24px selection circle, on or off. */
export function selectCheckClass(checked: boolean): string {
  return cn(
    'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 transition-colors',
    checked ? 'border-accent bg-accent text-accent-fg' : 'border-border-strong bg-panel',
  );
}

/**
 * The 24px select circle used by multi-select lists (chat rows, messages, the
 * forward picker). Decorative: the surrounding control carries the state.
 */
export function SelectCheck({ checked }: SelectCheckProps) {
  return (
    <span
      aria-hidden="true"
      data-select-check={checked ? 'on' : 'off'}
      className={selectCheckClass(checked)}
    >
      {checked ? <IconCheck size={ICON_SIZE.inline} /> : null}
    </span>
  );
}
