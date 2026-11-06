import { describe, expect, it } from 'vitest';
import { BANK_ITEM_PATH, planItemFocusHref } from '@/lib/focus-target';

describe('planItemFocusHref: where a plan item link lands', () => {
  it('a plan-less item opens the bank idea, with and without a comment', () => {
    expect(planItemFocusHref({ planId: null, itemId: 'i1' })).toBe('/plan/bank?item=i1');
    expect(planItemFocusHref({ planId: null, itemId: 'i1', commentId: 'c1' })).toBe(
      '/plan/bank?item=i1&comment=c1',
    );
  });

  it("scope_key 'bank' opens the bank even when a plan id rides along", () => {
    expect(planItemFocusHref({ planId: 'p1', scopeKey: 'bank', itemId: 'i1' })).toBe(
      '/plan/bank?item=i1',
    );
  });

  it('an item in a plan keeps its Plan tab link', () => {
    expect(planItemFocusHref({ planId: 'p1', scopeKey: 'p1', itemId: 'i1' })).toBe(
      '/plan/p1?item=i1',
    );
    expect(planItemFocusHref({ planId: 'p1', itemId: 'i1', commentId: 'c1' })).toBe(
      '/plan/p1?item=i1&comment=c1',
    );
  });

  it('the bank path is the Plan page bank route', () => {
    expect(BANK_ITEM_PATH).toBe('/plan/bank');
  });
});
