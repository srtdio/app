import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// The Plan screen and its frame portal into document.body (no DOM in the unit
// env): stub both to markers that print the props the page hands over, so the
// assertion is exactly what the route maps ?item= / ?comment= to.
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

import { PlanPage, isPlanId, planPageBack } from '@/components/pages/PlanPage';

const PLAN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ITEM = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const COMMENT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function render(path: string): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/plans/:planId" element={<PlanPage />} />
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
    expect(html).toContain('<p class="text-sm">Plan not available</p>');
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

  it('Back pops to the entry below when there is one, else goes to Activity (cold deep link)', () => {
    expect(planPageBack({ idx: 3, key: 'k' })).toEqual({ kind: 'pop' });
    expect(planPageBack({ idx: 0, key: 'k' })).toEqual({ kind: 'activity' });
    expect(planPageBack(null)).toEqual({ kind: 'activity' });
    expect(planPageBack(undefined)).toEqual({ kind: 'activity' });
  });
});
