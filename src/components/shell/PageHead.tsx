import type { ReactNode } from 'react';

interface PageHeadProps {
  title: string;
  actions?: ReactNode;
}

export function PageHead({ title, actions }: PageHeadProps) {
  return (
    <div className="flex items-center gap-3 h-14 px-4 md:px-6 border-b border-border">
      <h1 className="text-[15px] font-semibold">{title}</h1>
      {actions !== undefined ? (
        <div className="ml-auto flex items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}
