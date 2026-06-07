import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
}

const base =
  'inline-flex items-center justify-center gap-2 rounded-md font-medium select-none transition-colors disabled:opacity-50 disabled:pointer-events-none';

const sizes: Record<NonNullable<ButtonProps['size']>, string> = {
  sm: 'h-8 px-3 text-xs',
  md: 'h-9 px-3.5 text-sm',
  lg: 'h-11 px-4 text-sm',
};

const variants: Record<NonNullable<ButtonProps['variant']>, string> = {
  default: 'bg-panel-2 text-fg border border-border hover:bg-panel-3',
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover',
  ghost: 'text-fg-2 hover:bg-panel-2',
};

export function Button({ variant = 'default', size = 'md', className, ...props }: ButtonProps) {
  return <button className={cn(base, sizes[size], variants[variant], className)} {...props} />;
}
