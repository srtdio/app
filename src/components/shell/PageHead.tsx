import type { ReactNode } from 'react';

interface PageHeadProps {
  title: string;
  actions?: ReactNode;
  /**
   * The screen has no visible title bar in the design (Pipeline, Briefs,
   * Assets, Plan, Chat): render only the h1, sr-only, so screen readers and
   * route focus still find the screen's title. Nothing paints.
   */
  hidden?: boolean;
}

/**
 * The screen's title: the one h1. tabIndex -1 so a route change can move focus
 * to it (route-a11y.ts); it is never a Tab stop and draws no focus line.
 */
export function PageHead({ title, actions, hidden = false }: PageHeadProps) {
  if (hidden) {
    return (
      <h1 tabIndex={-1} className="sr-only">
        {title}
      </h1>
    );
  }
  return (
    <div className="flex items-center gap-3 h-14 px-4 md:px-6 border-b lit-header">
      <h1 tabIndex={-1} className="text-lg font-semibold focus:outline-none">
        {title}
      </h1>
      {actions !== undefined ? (
        <div className="ml-auto flex items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}
