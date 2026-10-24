import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  /** Drops the 320px min-height, for an empty state inside a list or column. */
  compact?: boolean;
}

export function EmptyState({ icon, title, description, action, compact = false }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center px-6 py-14 gap-1.5',
        compact ? null : 'min-h-[320px]',
      )}
    >
      <div className="w-[54px] h-[54px] rounded-xl bg-panel-2 border border-border flex items-center justify-center text-fg-3 mb-1.5">
        {icon}
      </div>
      <div className="text-lg font-semibold text-fg">{title}</div>
      {description !== undefined ? (
        <div className="text-base text-fg-2 max-w-[300px]">{description}</div>
      ) : null}
      {action !== undefined ? <div className="mt-3.5">{action}</div> : null}
    </div>
  );
}
