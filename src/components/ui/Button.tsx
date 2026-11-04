import type { ButtonHTMLAttributes, Ref } from 'react';
import { cn } from '@/lib/cn';
import { MOVE_CLASS } from '@/lib/motion';
import { ProgressRing } from '@/components/ui/ProgressRing';

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'ghost'
  | 'link'
  | 'success'
  | 'danger'
  /** Alias of 'secondary', kept for one release so older call sites compile. */
  | 'default';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /**
   * Accepted so call sites compile; has no visual effect. Every button is 44
   * tall (the design system has one height).
   */
  size?: 'sm' | 'md' | 'lg';
  /** 'round' renders a 44x44 circle (composer actions); default is the 8px-radius rectangle. */
  shape?: 'default' | 'round';
  /** Ref to the rendered <button>; a plain prop so Button stays a callable function. */
  buttonRef?: Ref<HTMLButtonElement> | undefined;
  /**
   * The action is running: the button is disabled and aria-busy, the label
   * stays as it is (never swapped for "Saving..."), and a small turning arc
   * sits beside it. Busy is the only reason a submit button is disabled; a
   * form that is not valid yet keeps its button live and shows the field error.
   */
  busy?: boolean | undefined;
}

// One height (44), one radius (8), one type (14 / 500). Tokens only, so light
// and dark match. cn() does not merge classes, so the radius and padding live in
// the shape classes (never both rounded-lg and rounded-full on one element).
// Callers never override a base property with the ! modifier (no-raw-button
// test): pick another variant or primitive instead.
// Press (motion move 5): MOVE_CLASS.press sinks to .97 while held, 120 ms, and
// eases colours; it ignores disabled and aria-disabled buttons.
// Hover and press keep the light: lit-hover (or the lit-btn-secondary rule)
// stacks the --hover-fill / --press-fill overlay, never a flat swap or opacity.
// Disabled never fades: filled buttons turn solid fg-3 with accent-fg text,
// the rest take text-fg-3; no hover (pointer-events-none), default cursor.
const BUTTON_BASE =
  'inline-flex h-11 min-h-[44px] min-w-[44px] items-center justify-center gap-2 text-base font-medium select-none disabled:pointer-events-none disabled:cursor-default focus-visible:lit-focus';

const FILLED_DISABLED = 'disabled:bg-fg-3 disabled:text-accent-fg';
const QUIET_DISABLED = 'disabled:text-fg-3';

const secondary = `lit-btn-secondary bg-panel text-fg border ${QUIET_DISABLED}`;

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: `lit-btn-primary bg-accent text-accent-fg hover:bg-accent-hover ${FILLED_DISABLED}`,
  secondary,
  ghost: `lit-hover text-fg-2 hover:text-fg ${QUIET_DISABLED}`,
  link: `text-accent !px-2 hover:bg-accent-soft ${QUIET_DISABLED}`,
  success: `lit-btn-success lit-hover bg-good-solid text-accent-fg ${FILLED_DISABLED}`,
  danger: `lit-btn-danger lit-hover bg-bad-solid text-accent-fg ${FILLED_DISABLED}`,
  default: secondary,
};

const BUTTON_SHAPES: Record<'default' | 'round', string> = {
  default: 'rounded-lg px-4',
  round: 'rounded-full w-11 px-0',
};

/** The class string a Button renders; exported for the few anchors that must look like one. */
export function buttonClass(
  variant: ButtonVariant = 'secondary',
  shape: 'default' | 'round' = 'default',
  className?: string,
): string {
  return cn(
    BUTTON_BASE,
    MOVE_CLASS.press,
    BUTTON_SHAPES[shape],
    BUTTON_VARIANTS[variant],
    className,
  );
}

export function Button({
  variant = 'secondary',
  size,
  shape = 'default',
  className,
  buttonRef,
  busy = false,
  disabled,
  children,
  ...props
}: ButtonProps) {
  void size;
  return (
    <button
      ref={buttonRef}
      className={buttonClass(variant, shape, className)}
      disabled={busy || disabled}
      aria-busy={busy ? true : undefined}
      {...props}
    >
      {busy ? <BusyArc /> : null}
      {children}
    </button>
  );
}

/**
 * The busy mark beside the label: the shared ProgressRing's indeterminate arc
 * (no track) turning on the motion module's spin (still under Reduce Motion).
 * currentColor ink, so it follows the button's own (disabled) text in light
 * and dark. Hidden from assistive tech; aria-busy carries the state.
 */
function BusyArc() {
  return (
    <ProgressRing
      progress={null}
      size={16}
      stroke={2}
      arc={0.25}
      className={cn('h-4 w-4 shrink-0', MOVE_CLASS.spin)}
      trackClass="text-transparent"
      arcClass="text-current"
    />
  );
}
