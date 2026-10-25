import type { ButtonHTMLAttributes, Ref } from 'react';
import { cn } from '@/lib/cn';

interface ChipProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'className' | 'onClick' | 'children'
> {
  label: string;
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
        'inline-flex items-center gap-1.5 rounded-lg border text-base font-normal transition-colors',
        sizes[size],
        'border-border text-fg-2 hover:bg-panel-2',
        selected && 'bg-accent-soft text-accent border-accent-line',
        variant === 'add' && 'border-dashed border-border text-fg-3',
        className,
      )}
    >
      {label}
      {count !== undefined && count > 0 ? (
        <>
          {' '}
          <span className="tabular-nums">{count}</span>
        </>
      ) : null}
    </button>
  );
}
