import type { ButtonHTMLAttributes, Ref } from 'react';
import { cn } from '@/lib/cn';
import { MOVE_CLASS } from '@/lib/motion';

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  /** Ref to the rendered <button>; a plain prop so IconButton stays a callable function. */
  buttonRef?: Ref<HTMLButtonElement> | undefined;
}

export function IconButton({ label, className, children, buttonRef, ...props }: IconButtonProps) {
  return (
    <button
      ref={buttonRef}
      aria-label={label}
      className={cn(
        // Hover/press: the lit-hover overlay. Disabled: fg-3 ink, no hover, never a fade.
        'inline-flex items-center justify-center h-11 w-11 min-h-[44px] min-w-[44px] rounded-lg text-fg lit-hover hover:text-fg focus-visible:lit-focus disabled:text-fg-3 disabled:pointer-events-none disabled:cursor-default',
        MOVE_CLASS.press,
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
