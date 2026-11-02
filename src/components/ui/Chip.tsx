import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { cn } from '@/lib/cn';

interface ChipProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'className' | 'onClick' | 'children'
> {
  label: string;
  /** An optional leading mark before the label (Pipeline's stage dot). */
  dot?: ReactNode;
  /**
   * An optional mark after the label (the Plan tab's Draft tag). When set, the
   * label truncates in its own span so the mark keeps the chip's right end.
   */
  trailing?: ReactNode;
  /** A filter's count, shown after the label only when above 0. */
  count?: number;
  selected?: boolean;
  variant?: 'default' | 'add';
  /**
   * Both sizes render the one 44px button height (design system); 'sm' stays
   * accepted so call sites compile.
   */
  size?: 'sm' | 'tap';
  /**
   * Optional extra classes appended last (e.g. a consumer's layout constraints
   * like shrink-0 / truncate). Purely additive: omitted by default so every
   * existing consumer renders byte-for-byte the same.
   */
  className?: string;
  onClick?: ButtonHTMLAttributes<HTMLButtonElement>['onClick'];
  /** Ref to the rendered <button>; a plain prop so Chip stays a callable function. */
  buttonRef?: Ref<HTMLButtonElement> | undefined;
}

const sizes: Record<NonNullable<ChipProps['size']>, string> = {
  sm: 'min-h-[44px] px-4',
  tap: 'min-h-[44px] px-4 justify-center',
};

export function Chip({
  label,
  dot,
  trailing,
  count,
  selected = false,
  variant = 'default',
  size = 'sm',
  className,
  onClick,
  buttonRef,
  ...props
}: ChipProps) {
  return (
    <button
      type="button"
      {...props}
      ref={buttonRef}
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-lg border text-base font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
        sizes[size],
        variant === 'add'
          ? 'border-dashed border-border text-fg-3 hover:bg-panel-2'
          : selected
            ? 'lit-chip-selected text-accent border-accent-line'
            : 'lit-chip text-fg hover:bg-panel-2',
        className,
      )}
    >
      {dot}
      {trailing === undefined ? label : <span className="truncate">{label}</span>}
      {trailing}
      {count !== undefined && count > 0 ? (
        <>
          {' '}
          <span className="tabular-nums">{count}</span>
        </>
      ) : null}
    </button>
  );
}
