import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { cn } from '@/lib/cn';
import { MOVE_CLASS } from '@/lib/motion';

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
  /**
   * The chip's on state. When set, a toggle chip announces it as aria-pressed;
   * a tab chip (`tab`, or role="tab") announces it as aria-selected instead.
   */
  selected?: boolean;
  /**
   * The chip is one tab of a role="tablist" row (in-sheet segment tabs): it
   * renders role="tab" with aria-selected, never aria-pressed.
   */
  tab?: boolean;
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
  sm: 'min-h-11 px-4',
  tap: 'min-h-11 px-4 justify-center',
};

/**
 * The chip's state for assistive tech: a tab chip is role="tab" with
 * aria-selected; a toggle chip (selected given) is aria-pressed; an action chip
 * (no selected) carries neither. A call site's own aria props still win. Pure.
 */
export function chipStateAria(
  selected: boolean | undefined,
  tab: boolean,
): { role?: 'tab'; 'aria-selected'?: boolean; 'aria-pressed'?: boolean } {
  if (tab) return { role: 'tab', 'aria-selected': selected ?? false };
  if (selected === undefined) return {};
  return { 'aria-pressed': selected };
}

export function Chip({
  label,
  dot,
  trailing,
  count,
  selected: selectedProp,
  tab = false,
  variant = 'default',
  size = 'sm',
  className,
  onClick,
  buttonRef,
  ...props
}: ChipProps) {
  const selected = selectedProp ?? false;
  return (
    <button
      type="button"
      {...chipStateAria(selectedProp, tab || props.role === 'tab')}
      {...props}
      ref={buttonRef}
      data-selected={selected ? 'true' : undefined}
      onClick={onClick}
      className={cn(
        // At rest a quiet grey fill (no edge); the pick is the solid ink fill
        // (bg-accent, lit-pill), the same look as a picked day. Hover/press: the
        // lit-hover overlay, no flat swap. Disabled: fg-3 ink, never a fade.
        'inline-flex items-center gap-1.5 rounded-lg border text-base font-medium focus-visible:lit-focus disabled:text-fg-3 disabled:pointer-events-none disabled:cursor-default',
        MOVE_CLASS.press,
        sizes[size],
        variant === 'add'
          ? 'lit-chip border-dashed border-border-strong text-fg-3'
          : selected
            ? 'border-transparent bg-accent text-accent-fg lit-pill'
            : 'border-transparent bg-panel-3 text-fg lit-well-soft lit-hover',
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
