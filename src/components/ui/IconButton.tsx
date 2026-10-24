import type { ButtonHTMLAttributes, Ref } from 'react';
import { cn } from '@/lib/cn';

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
        'inline-flex items-center justify-center h-11 w-11 min-h-[44px] min-w-[44px] rounded-lg text-fg-2 hover:bg-panel-2 hover:text-fg transition-[color,background-color,transform] duration-fast active:scale-[0.97]',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
