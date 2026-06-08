import { describe, it, expect } from 'vitest';
import { briefCloseFields, mapBriefStatus } from '../src/transform.ts';

// Regression tests for the briefs close columns. The bug: load.ts set
// briefs.status from mapBriefStatus but never set closed_at/closed_by, so a
// status='closed' row inserted with both NULL and violated the v2
// briefs_closed_consistency CHECK:
//   (status='open'   AND closed_at IS NULL     AND closed_by IS NULL)
//   OR (status='closed' AND closed_at IS NOT NULL AND closed_by IS NOT NULL)
// briefCloseFields must keep every row self-consistent with that CHECK.

const OPERATOR = '00000000-0000-0000-0000-000000000001';

// Mirror of the DB CHECK so a passing assertion proves the row would insert.
function satisfiesConstraint(
  status: string,
  closedAt: Date | string | null,
  closedBy: string | null,
): boolean {
  return (
    (status === 'open' && closedAt === null && closedBy === null) ||
    (status === 'closed' && closedAt !== null && closedBy !== null)
  );
}

describe('briefCloseFields', () => {
  it('closed request maps to closed with both close columns non-null', () => {
    const status = mapBriefStatus('closed');
    const targetDate = new Date('2025-01-15T00:00:00.000Z');
    const close = briefCloseFields(status, targetDate, OPERATOR, new Date());

    expect(status).toBe('closed');
    expect(close.closed_at).toBe(targetDate);
    expect(close.closed_by).toBe(OPERATOR);
    expect(close.closed_at).not.toBeNull();
    expect(close.closed_by).not.toBeNull();
    expect(satisfiesConstraint(status, close.closed_at, close.closed_by)).toBe(true);
  });

  it('closed request with no target_date still gets a non-null closed_at fallback', () => {
    const status = mapBriefStatus('closed');
    const fallback = new Date('2026-06-08T12:00:00.000Z');
    const close = briefCloseFields(status, null, OPERATOR, fallback);

    expect(close.closed_at).toBe(fallback);
    expect(close.closed_at).not.toBeNull();
    expect(close.closed_by).toBe(OPERATOR);
    expect(satisfiesConstraint(status, close.closed_at, close.closed_by)).toBe(true);
  });

  it.each(['pending', 'assigned', null])(
    'non-closed status %s maps to open with both close columns null',
    (raw) => {
      const status = mapBriefStatus(raw);
      const close = briefCloseFields(status, new Date(), OPERATOR, new Date());

      expect(status).toBe('open');
      expect(close.closed_at).toBeNull();
      expect(close.closed_by).toBeNull();
      expect(satisfiesConstraint(status, close.closed_at, close.closed_by)).toBe(true);
    },
  );
});
