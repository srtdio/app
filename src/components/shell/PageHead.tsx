import type { ReactNode } from 'react';
import { HeaderBar } from '@/components/ui/HeaderBar';

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
  // The one header bar (ui/HeaderBar): title role, gutter 16/24, 56 tall,
  // trailing actions under the trailing rule.
  return (
    <HeaderBar title={title} compact routeFocus {...(actions !== undefined ? { actions } : {})} />
  );
}
