import type { InputHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'w-full h-11 px-3 rounded-md border border-border bg-panel-2 text-fg text-sm placeholder:text-fg-3 outline-none focus:border-accent-line focus:ring-2 focus:ring-accent-soft',
        className,
      )}
      {...props}
    />
  );
}
