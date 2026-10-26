import type { ButtonHTMLAttributes, Ref } from 'react';
import { cn } from '@/lib/cn';

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
}

// One height (44), one radius (8), one type (14 / 500). Tokens only, so light
// and dark match. cn() does not merge classes, so the radius and padding live in
// the shape classes (never both rounded-lg and rounded-full on one element).
// Callers never override a base property with the ! modifier (no-raw-button
// test): pick another variant or primitive instead.
const BUTTON_BASE =
  'inline-flex h-11 min-h-[44px] min-w-[44px] items-center justify-center gap-2 text-base font-medium select-none transition-[color,background-color,border-color,transform] duration-fast active:scale-[0.97] disabled:opacity-50 disabled:pointer-events-none focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg';

const secondary = 'bg-panel text-fg border border-border hover:bg-panel-2';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover',
  secondary,
  ghost: 'text-fg-2 hover:bg-panel-2 hover:text-fg',
  link: 'text-accent !px-2 hover:bg-accent-soft',
  success: 'bg-good-solid text-accent-fg hover:opacity-90',
  danger: 'bg-bad-solid text-accent-fg hover:opacity-90',
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
  return cn(BUTTON_BASE, BUTTON_SHAPES[shape], BUTTON_VARIANTS[variant], className);
}

export function Button({
  variant = 'secondary',
  size,
  shape = 'default',
  className,
  buttonRef,
  ...props
}: ButtonProps) {
  void size;
  return <button ref={buttonRef} className={buttonClass(variant, shape, className)} {...props} />;
}
