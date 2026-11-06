// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import { PLAN_ROW_TO_BANK_EVENT, dispatchRowToBank, withRowToBank } from './plan-bank-extras';

describe('row to bank (item screen -> Plan screen)', () => {
  it('hides on leave and shows on back, same set when nothing changes', () => {
    const empty: ReadonlySet<string> = new Set();
    const hidden = withRowToBank(empty, { itemId: 'a', back: false });
    expect([...hidden]).toEqual(['a']);
    expect(withRowToBank(hidden, { itemId: 'a', back: false })).toBe(hidden);
    expect([...withRowToBank(hidden, { itemId: 'a', back: true })]).toEqual([]);
    expect(withRowToBank(empty, { itemId: 'a', back: true })).toBe(empty);
  });

  it('dispatches the detail on the window', () => {
    const seen: unknown[] = [];
    const on = (e: Event): void => {
      seen.push((e as CustomEvent).detail);
    };
    window.addEventListener(PLAN_ROW_TO_BANK_EVENT, on);
    dispatchRowToBank(window, { itemId: 'x', back: false });
    window.removeEventListener(PLAN_ROW_TO_BANK_EVENT, on);
    expect(seen).toEqual([{ itemId: 'x', back: false }]);
  });
});
