import type { InputHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

// 16px text below md so iOS Safari does not zoom the page when the field takes
// focus; the usual 14px from md up.
export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'w-full h-11 px-3 rounded-lg border border-border bg-panel-2 text-fg text-legacy-base md:text-legacy-sm placeholder:text-fg-3 outline-none focus:border-accent-line focus:ring-2 focus:ring-accent-soft',
        className,
      )}
      {...props}
    />
  );
}
