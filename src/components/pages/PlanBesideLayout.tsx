// The route layout over a page and its plan route (Notifications over
// /notifications and /plans/:planId, the Plan tab over /plan and
// /plan/:planId): see PlanPage.tsx for the behaviour. It lives in its own tiny
// module so the page beside it (Activity, the Plan tab) loads as one chunk
// without the Plan screen: the plan route itself stays lazy (App.tsx renders
// PlanPage through its own page(...) element), and nothing here imports it.

import type { ReactElement } from 'react';
import { Outlet, useMatch } from 'react-router-dom';
import { cn } from '@/lib/cn';
import { useIsLaptop } from '@/lib/use-is-laptop';

/**
 * The route layout over a page and its plan route (`planPattern`): the page in
 * one fixed place (never remounted between the two) on a laptop and on the
 * page's own route, with the plan route beside it. From 1180px the page
 * narrows by the panel's width; below, the panel overlays it.
 */
export function PlanBesideLayout(props: { page: ReactElement; planPattern: string }): ReactElement {
  const plan = useMatch(props.planPattern) !== null;
  const desktop = useIsLaptop();
  return (
    <>
      {!plan || desktop ? (
        <div data-plan-beside="" className={cn(plan && 'min-[1180px]:mr-[440px]')}>
          {props.page}
        </div>
      ) : null}
      <Outlet />
    </>
  );
}
