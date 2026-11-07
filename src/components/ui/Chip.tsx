import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { cn } from '@/lib/cn';
import { MOVE_CLASS } from '@/lib/motion';
import { Button } from '@/components/ui/Button';

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
   * Both sizes render the one 32px visible chip inside a 44px tap box (design
   * system); 'tap' also centres the label. 'sm' stays accepted so call sites compile.
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
  /**
   * A clear action: when set, a ghost "Clear" text Button (44 tall, its own
   * button, labelled "Clear <label> filter") sits right after the chip. No X
   * (no-cross guard). Unset, the chip renders exactly as without this prop.
   */
  onClear?: (() => void) | undefined;
}

/** The visible chip: 32 tall (min-h-8, borders included), 12 side padding. */
const sizes: Record<NonNullable<ChipProps['size']>, string> = {
  sm: 'min-h-8 px-3',
  tap: 'min-h-8 px-3 justify-center',
};

/**
 * The 44 tap box around the 32 chip: no look of its own (transparent, no
 * padding), so a chip row keeps its 44 height. At least 44 wide too (a short
 * label like "All" stretches the face to 44), a full pill like the face. Its
 * focus line is drawn on the visible chip, the box's one child span.
 */
export const CHIP_HIT =
  'group relative inline-flex min-h-11 min-w-11 items-center rounded-full outline-none [&:focus-visible>span]:lit-focus disabled:pointer-events-none disabled:cursor-default';

/** A call site's layout classes that also apply to the tap box (it sits in their row). */
const LAYOUT = /^(flex|shrink|grow|basis-|self-|order-|w-|min-w-|max-w-)/;

/** The caller's className split: layout classes for the tap box (the chip face gets all). Pure. */
export function chipHitLayout(className: string | undefined): string | undefined {
  if (className === undefined) return undefined;
  const kept = className.split(/\s+/).filter((t) => LAYOUT.test(t));
  return kept.length > 0 ? kept.join(' ') : undefined;
}

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
  onClear,
  ...props
}: ChipProps) {
  const selected = selectedProp ?? false;
  const chip = (
    <button
      type="button"
      {...chipStateAria(selectedProp, tab || props.role === 'tab')}
      {...props}
      ref={buttonRef}
      data-selected={selected ? 'true' : undefined}
      onClick={onClick}
      className={cn(CHIP_HIT, MOVE_CLASS.press, chipHitLayout(className))}
    >
      <span
        data-chip-face=""
        className={cn(
          // Flat outline pill (7 Nov 2026): at rest a hairline and fg-2 ink; the
          // pick is the ink line (black light, white dark) and fg ink, no fill.
          // Hover/press: the lit-hover overlay. Disabled: fg-3 ink, never a fade.
          'inline-flex min-w-0 flex-1 items-center gap-2 rounded-full border text-md font-medium lit-hover group-disabled:text-fg-3',
          sizes[size],
          variant === 'add'
            ? 'border-dashed border-border-strong text-fg-3'
            : selected
              ? 'border-fg text-fg'
              : 'border-border text-fg-2',
          className,
        )}
      >
        {dot}
        {trailing === undefined ? label : <span className="truncate">{label}</span>}
        {trailing}
        {count !== undefined && count > 0 ? (
          <>
            {' '}
            <span className="tabular-nums text-fg-3">{count}</span>
          </>
        ) : null}
      </span>
    </button>
  );
  if (onClear === undefined) return chip;
  // "Clear" is a sibling (never a button in a button): the shared ghost Button,
  // 44 tall, 12 side padding, right after the 32 chip in the same 44 row.
  return (
    <span data-chip-clearable="" className="inline-flex shrink-0 items-center">
      {chip}
      <Button
        type="button"
        variant="ghost"
        data-chip-clear=""
        aria-label={`Clear ${label} filter`}
        onClick={onClear}
        className="shrink-0 px-3 focus-visible:lit-focus"
      >
        Clear
      </Button>
    </span>
  );
}
