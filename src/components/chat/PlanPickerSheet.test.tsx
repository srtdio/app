import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({ default: {} }));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import { SEARCH_PLANS_LABEL, pickedPlanId } from '@/components/chat/PlanPickerSheet';
import type { WorkspaceHit } from '@/lib/search/workspace-search';

function hit(kind: WorkspaceHit['kind'], id: string): WorkspaceHit {
  return {
    kind,
    id,
    parentId: null,
    channelId: null,
    entityType: '',
    number: null,
    title: id,
    snippet: '',
    actorUserId: null,
    actorIsMember: false,
    createdAt: '2026-11-01T00:00:00Z',
  };
}

describe('PlanPickerSheet search: the palette in pick mode', () => {
  const src = readFileSync(
    fileURLToPath(new URL('./PlanPickerSheet.tsx', import.meta.url)),
    'utf8',
  );

  it('a search button in the sheet header asks for plans only, one pick', () => {
    expect(SEARCH_PLANS_LABEL).toBe('Search plans');
    expect(src).toContain('headerAction={');
    expect(src).toContain('<PalettePickButton');
    expect(src).toContain("pickKinds: ['plan']");
    expect(src).toContain('multi: false');
  });

  it('the pick opens that plan the way a row tap does', () => {
    expect(src).toMatch(
      /onPick: \(hits\) => \{[\s\S]*?pickedPlanId\(hits\)[\s\S]*?props\.onClose\(\);[\s\S]*?props\.onOpenPlan\(planId\);/,
    );
    expect(pickedPlanId([hit('post', 'p1'), hit('plan', 'plan-1')])).toBe('plan-1');
    expect(pickedPlanId([hit('post', 'p1')])).toBeNull();
    expect(pickedPlanId([])).toBeNull();
  });
});
