import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { cn } from '@/lib/cn';
import { MOVE_CLASS } from '@/lib/motion';
import { ICON_SIZE, IconX } from '@/components/ui/icons';

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
   * A clear action: when set, a trailing X (its own 44x44 button, labelled
   * "Clear <label> filter") sits on the chip's right end, in the chip's text
   * colour. Unset, the chip renders exactly as without this prop.
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
 * label like "All" stretches the face to 44), radius 8 like every button. Its
 * focus line is drawn on the visible chip, the box's one child span.
 */
export const CHIP_HIT =
  'group relative inline-flex min-h-11 min-w-11 items-center rounded-lg outline-none [&:focus-visible>span]:lit-focus disabled:pointer-events-none disabled:cursor-default';

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
          // At rest a quiet grey fill (no edge); the pick is the solid ink fill
          // (bg-accent, lit-pill), the same look as a picked day. Hover/press: the
          // lit-hover overlay, no flat swap. Disabled: fg-3 ink, never a fade.
          'inline-flex min-w-0 flex-1 items-center gap-2 rounded-lg border text-md font-medium group-disabled:text-fg-3',
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
        {onClear !== undefined ? <span aria-hidden="true" className="w-4 shrink-0" /> : null}
      </span>
    </button>
  );
  if (onClear === undefined) return chip;
  // The X is a sibling (never a button in a button): a 44x44 box on the
  // chip's right end whose glyph sits where the chip reserved its width,
  // vertically centred on the 32 chip, 12 in from its right edge.
  return (
    <span data-chip-clearable="" className="relative inline-flex shrink-0">
      {chip}
      <button
        type="button"
        data-chip-clear=""
        aria-label={`Clear ${label} filter`}
        onClick={onClear}
        className={cn(
          'absolute inset-y-0 right-0 inline-flex min-h-11 w-11 items-center justify-end rounded-lg pr-3 focus-visible:lit-focus',
          selected ? 'text-accent-fg' : 'text-fg',
        )}
      >
        <IconX size={ICON_SIZE.inline} />
      </button>
    </span>
  );
}
