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

export type ButtonShape = 'default' | 'round' | 'pill';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /**
   * 'round' renders a 44x44 circle (composer actions); 'pill' is the sheet
   * primary action (Done / OK / Save: full radius, 24 side padding, same 44
   * height, auto width); default is the 8px-radius rectangle.
   */
  shape?: ButtonShape;
  /** Ref to the rendered <button>; a plain prop so Button stays a callable function. */
  buttonRef?: Ref<HTMLButtonElement> | undefined;
  /**
   * The action is running: the button is disabled and aria-busy, the label
   * keeps its place (invisible, so the width never changes; never swapped for
   * "Saving…"), and a small turning arc sits over its centre. Busy is the only reason a submit button is disabled; a
   * form that is not valid yet keeps its button live and shows the field error.
   */
  busy?: boolean | undefined;
}

// One height (44), one radius (8), one type (14 / 500). Tokens only, so light
// and dark match. cn() merges classes (tailwind-merge): a caller's class of the
// same group replaces the base one (px-3 over px-4, min-w-0 over min-w-11).
// Callers never override a base property with the ! modifier (no-raw-button
// test): pick another variant or primitive instead.
// Press (motion move 5): MOVE_CLASS.press sinks to .97 while held, 120 ms, and
// eases colours; it ignores disabled and aria-disabled buttons.
// Hover and press keep the light: lit-hover (or the lit-btn-secondary rule)
// stacks the --hover-fill / --press-fill overlay, never a flat swap or opacity.
// Disabled never fades: filled buttons turn solid fg-3 with accent-fg text,
// the rest take text-fg-3; no hover (pointer-events-none), default cursor.
const BUTTON_BASE =
  'inline-flex h-11 min-h-11 min-w-11 items-center justify-center gap-2 text-base font-medium select-none disabled:pointer-events-none disabled:cursor-default focus-visible:lit-focus';

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

const BUTTON_SHAPES: Record<ButtonShape, string> = {
  default: 'rounded-lg px-4',
  round: 'rounded-full w-11 px-0',
  pill: 'rounded-full px-6',
};

/** The class string a Button renders; exported for the few anchors that must look like one. */
export function buttonClass(
  variant: ButtonVariant = 'secondary',
  shape: ButtonShape = 'default',
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
  shape = 'default',
  className,
  buttonRef,
  busy = false,
  disabled,
  children,
  ...props
}: ButtonProps) {
  // Busy keeps the width: the label (and icon) stay in place, invisible, and
  // the arc sits in the same grid cell over their centre, so a busy button
  // never grows or jumps. The button's own classes never change.
  return (
    <button
      ref={buttonRef}
      className={buttonClass(variant, shape, className)}
      {...props}
      disabled={busy || disabled}
      aria-busy={busy ? true : props['aria-busy']}
    >
      {busy ? (
        <span data-busy="" className="grid place-items-center">
          <span
            data-busy-label=""
            className="invisible col-start-1 row-start-1 inline-flex items-center gap-2"
          >
            {children}
          </span>
          <span data-busy-arc="" className="col-start-1 row-start-1 flex">
            <BusyArc />
          </span>
        </span>
      ) : (
        children
      )}
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

/**
 * The visible face of the outlined Clear pill: 36 tall (the chip face height),
 * a border-strong hairline (3:1 edge rule), fg-2 ink, no fill. It sits inside
 * the 44 tall ghost pill Button, so the tap box stays 44.
 */
export const CLEAR_PILL_FACE =
  'inline-flex h-9 items-center rounded-full border border-border-strong px-4 text-fg-2';

/**
 * Clear (dismiss a toast, drop a reply/edit/about bar, remove a link preview,
 * clear a chip filter or a date): the outlined pill. The shared ghost Button in
 * the pill shape (44 tall hit, no padding of its own) around a 36 face with the
 * border-strong hairline. `faceClassName` is for a tone that needs other ink
 * (the error toast's accent-fg on red).
 */
export function ClearButton({
  children = 'Clear',
  className,
  faceClassName,
  ...props
}: Omit<ButtonProps, 'variant' | 'shape'> & { faceClassName?: string | undefined }) {
  return (
    <Button
      type="button"
      {...props}
      variant="ghost"
      shape="pill"
      data-clear-pill=""
      className={cn('shrink-0 px-0 [&:disabled>span]:text-fg-3', className)}
    >
      <span data-clear-face="" className={cn(CLEAR_PILL_FACE, faceClassName)}>
        {children}
      </span>
    </Button>
  );
}
