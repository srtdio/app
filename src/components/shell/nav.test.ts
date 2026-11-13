import { describe, expect, it } from 'vitest';
import { PRIMARY_NAV } from '@/components/shell/nav';
import { IconPlan } from '@/components/ui/icons';

describe('PRIMARY_NAV', () => {
  it('reads Pipeline, Briefs, Assets, Plan, Chat: Activity is not a nav item (top bar on laptop, pill on phone)', () => {
    expect(PRIMARY_NAV.map((item) => item.label)).toEqual([
      'Pipeline',
      'Briefs',
      'Assets',
      'Plan',
      'Chat',
    ]);
    expect(PRIMARY_NAV.map((item) => item.to)).not.toContain('/activity');
  });

  it('Plan opens /plan with the plan icon and carries no badge (13 Nov 2026)', () => {
    const plan = PRIMARY_NAV.find((item) => item.label === 'Plan');
    expect(plan).toEqual({ to: '/plan', label: 'Plan', Icon: IconPlan });
  });

  it('only Chat carries a number in the nav list (Activity keeps its own)', () => {
    expect(PRIMARY_NAV.filter((item) => item.showChatBadge === true).map((i) => i.label)).toEqual([
      'Chat',
    ]);
    expect(PRIMARY_NAV.some((item) => 'showPlanBadge' in item)).toBe(false);
  });
});
