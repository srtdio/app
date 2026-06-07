import type { ReactNode } from 'react';

interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center text-center px-6 py-14 gap-1.5 min-h-[320px]">
      <div className="w-[54px] h-[54px] rounded-[14px] bg-panel-2 border border-border flex items-center justify-center text-fg-3 mb-1.5">
        {icon}
      </div>
      <div className="text-[15px] font-semibold">{title}</div>
      {description !== undefined ? (
        <div className="text-fg-3 text-sm max-w-[300px]">{description}</div>
      ) : null}
      {action !== undefined ? <div className="mt-3.5">{action}</div> : null}
    </div>
  );
}
