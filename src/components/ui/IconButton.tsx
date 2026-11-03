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
        'inline-flex items-center justify-center h-11 w-11 min-h-[44px] min-w-[44px] rounded-lg text-fg hover:bg-panel-2 hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
        MOVE_CLASS.press,
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
