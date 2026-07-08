import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
}

export function IconButton({ label, className, children, ...props }: IconButtonProps) {
  return (
    <button
      aria-label={label}
      className={cn(
        'inline-flex items-center justify-center h-11 w-11 rounded-md text-fg-2 hover:bg-panel-2 hover:text-fg transition-[color,background-color,transform] duration-fast active:scale-[0.97]',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
