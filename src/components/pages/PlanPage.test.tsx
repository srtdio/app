import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// The Plan screen and its frame portal into document.body (no DOM in the unit
// env): stub both to markers that print the props the page hands over, so the
// assertion is exactly what the route maps ?item= / ?comment= to.
// Laptop or phone, as the test sets it; Notifications is a marker (its reads stay out).
const view = vi.hoisted(() => ({ desktop: false }));
const Beside = () => <div>activity-beside</div>;
vi.mock('@/lib/use-media-query', () => ({
  LAPTOP_QUERY: '(min-width: 768px)',
  useMediaQuery: () => view.desktop,
}));
vi.mock('@/components/chat/PlanScreen', () => ({
  PlanScreen: (props: {
    planId: string;
    initialItemId?: string;
    highlightCommentId?: string;
    onlyWorkspaceId?: string;
    senderName?: string;
    chatTitle?: string;
  }) => (
    <div>
      {`screen plan=${props.planId} item=${props.initialItemId ?? '-'} comment=${props.highlightCommentId ?? '-'} ws=${props.onlyWorkspaceId ?? '-'} shared=${props.senderName ?? props.chatTitle ?? '-'}`}
    </div>
  ),
  PlanPage: (props: { title: string; backLabel: string; children: ReactNode }) => (
    <div>
      {`frame title=${props.title} back=${props.backLabel}`}
      {props.children}
    </div>
  ),
}));
vi.mock('@/lib/workspace-context', () => ({ useWorkspace: () => ({ workspaceId: 'ws-1' }) }));

import {
  PlanBesideLayout,
  PlanPage,
  isPlanId,
  isPlanPath,
  planPageBack,
  replacesPlanEntry,
} from '@/components/pages/PlanPage';

const PLAN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ITEM = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const COMMENT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

// The app's route shapes: /notifications and /plans/:planId under one layout,
// /plan and /plan/:planId (the Plan tab) under another.
function render(path: string): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<PlanBesideLayout page={<Beside />} planPattern="/plans/:planId" />}>
          <Route path="/notifications" />
          <Route path="/plans/:planId" element={<PlanPage fallback="/notifications" />} />
        </Route>
        <Route element={<PlanBesideLayout page={<Beside />} planPattern="/plan/:planId" />}>
          <Route path="/plan" />
          <Route path="/plan/:planId" element={<PlanPage fallback="/plan" />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('PlanPage', () => {
  it('opens the plan with the ?item= item and the ?comment= highlight, scoped to the workspace', () => {
    expect(render(`/plans/${PLAN}?item=${ITEM}&comment=${COMMENT}`)).toContain(
      `screen plan=${PLAN} item=${ITEM} comment=${COMMENT} ws=ws-1 shared=-`,
    );
  });

  it('a review link opens the item with no highlight', () => {
    expect(render(`/plans/${PLAN}?item=${ITEM}`)).toContain(`item=${ITEM} comment=-`);
  });

  it('no ?item= opens the plan list (no item, no highlight)', () => {
    expect(render(`/plans/${PLAN}`)).toContain(`screen plan=${PLAN} item=- comment=-`);
  });

  it('a malformed ?item= or ?comment= is ignored, never read', () => {
    expect(render(`/plans/${PLAN}?item=nope&comment=${COMMENT}`)).toContain('item=- comment=-');
    expect(render(`/plans/${PLAN}?item=${ITEM}&comment=x`)).toContain(`item=${ITEM} comment=-`);
  });

  it('a malformed plan id shows the "Plan not available" state, never a blank page', () => {
    const html = render('/plans/not-a-plan');
    expect(html).toContain('frame title=Plan not available back=Back');
    expect(html).toContain('<p class="text-base">Plan not available</p>');
    expect(html).not.toContain('screen plan=');
  });

  it('isPlanId accepts only uuid-shaped values', () => {
    expect(isPlanId(PLAN)).toBe(true);
    expect(isPlanId(PLAN.toUpperCase())).toBe(true);
    expect(isPlanId('plan1')).toBe(false);
    expect(isPlanId('')).toBe(false);
    expect(isPlanId(null)).toBe(false);
    expect(isPlanId(undefined)).toBe(false);
  });

  it('laptop: Notifications stays visible beside the docked panel, narrowed by 440px from 1180px', () => {
    view.desktop = true;
    try {
      const html = render(`/plans/${PLAN}?item=${ITEM}`);
      expect(html).toContain('activity-beside');
      expect(html).toContain('min-[1180px]:mr-[440px]');
      expect(html).toContain(`screen plan=${PLAN} item=${ITEM}`);
      expect(render('/plans/not-a-plan')).toContain('activity-beside');
    } finally {
      view.desktop = false;
    }
  });

  it('phone: the plan alone, nothing under it; /notifications is Notifications', () => {
    expect(render(`/plans/${PLAN}`)).not.toContain('activity-beside');
    expect(render('/notifications')).toContain('activity-beside');
    expect(render('/notifications')).not.toContain('screen plan=');
  });

  it('the Plan tab: /plan/:id opens the plan, docked beside the calendar on a laptop', () => {
    expect(render(`/plan/${PLAN}`)).toContain(`screen plan=${PLAN}`);
    expect(render(`/plan/${PLAN}`)).not.toContain('activity-beside');
    view.desktop = true;
    try {
      const html = render(`/plan/${PLAN}?item=${ITEM}`);
      expect(html.indexOf('activity-beside')).toBeLessThan(html.indexOf('screen plan='));
      expect(html).toContain('min-[1180px]:mr-[440px]');
    } finally {
      view.desktop = false;
    }
  });

  it('laptop: Notifications sits in the same place on /notifications and /plans/:id (no remount)', () => {
    view.desktop = true;
    try {
      const a = render('/notifications');
      const p = render(`/plans/${PLAN}`);
      // The same first node, Activity, before the plan.
      expect(a.indexOf('activity-beside')).toBeGreaterThan(-1);
      expect(p.indexOf('activity-beside')).toBeLessThan(p.indexOf('screen plan='));
      expect(a).not.toContain('min-[1180px]:mr-[440px]');
    } finally {
      view.desktop = false;
    }
  });

  it('laptop: a plan pushed over a plan replaces its entry (Close is one step to the page)', () => {
    const base = { desktop: true, navType: 'PUSH' as const, prev: '/plans/a', here: '/plans/b' };
    expect(replacesPlanEntry(base)).toBe(true);
    expect(replacesPlanEntry({ ...base, prev: '/plan/a', here: '/plan/b' })).toBe(true);
    expect(replacesPlanEntry({ ...base, prev: '/notifications' })).toBe(false);
    expect(replacesPlanEntry({ ...base, prev: '/plan', here: '/plan/b' })).toBe(false);
    expect(replacesPlanEntry({ ...base, navType: 'POP' })).toBe(false);
    expect(replacesPlanEntry({ ...base, navType: 'REPLACE' })).toBe(false);
    expect(replacesPlanEntry({ ...base, desktop: false })).toBe(false);
    expect(replacesPlanEntry({ ...base, here: '/plans/a' })).toBe(false);
  });

  it('Back pops to the entry below when there is one, else the page beside (cold deep link)', () => {
    expect(planPageBack({ idx: 3, key: 'k' })).toEqual({ kind: 'pop' });
    expect(planPageBack({ idx: 0, key: 'k' })).toEqual({ kind: 'fallback' });
    expect(planPageBack(null)).toEqual({ kind: 'fallback' });
    expect(planPageBack(undefined)).toEqual({ kind: 'fallback' });
  });

  it('isPlanPath: both plan routes, never the pages beside them', () => {
    expect(isPlanPath('/plans/x')).toBe(true);
    expect(isPlanPath('/plan/x')).toBe(true);
    expect(isPlanPath('/plan')).toBe(false);
    expect(isPlanPath('/notifications')).toBe(false);
  });
});
