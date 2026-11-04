import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { cn } from '@/lib/cn';
import { MOVE_CLASS } from '@/lib/motion';

interface ChipProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'onClick' | 'children'> {
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
        // Hover/press: the lit-chip / lit-selected overlay rule (index.css), no
        // flat swap. Disabled: fg-3 ink, no hover, never a fade.
        'inline-flex items-center gap-1.5 rounded-lg border text-base font-medium focus-visible:lit-focus disabled:text-fg-3 disabled:pointer-events-none disabled:cursor-default',
        MOVE_CLASS.press,
        sizes[size],
        variant === 'add'
          ? 'lit-chip border-dashed border-border-strong text-fg-3'
          : selected
            ? 'lit-selected'
            : 'lit-chip border-border-strong text-fg',
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
