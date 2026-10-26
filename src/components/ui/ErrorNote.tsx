import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

interface ErrorNoteProps {
  children: ReactNode;
  /** Layout extras only (margins, flex for an icon row). */
  className?: string;
}

/** The one inline error box: "Couldn't {action}. {reason}" copy goes inside. */
export function ErrorNote({ children, className }: ErrorNoteProps) {
  return (
    <div
      role="alert"
      className={cn(
        'rounded-lg border border-bad bg-bad-soft px-3 py-2 text-base text-bad',
        className,
      )}
    >
      {children}
    </div>
  );
}
