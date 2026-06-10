// Seat usage: a workspace's active-member count measured against its plan's
// seat allowance. Pure, dependency-free logic so it runs under the root unit
// config (no database) and can be reused by the UI and any future server gate.
//
// Allowances come from PRD section 5 (Pricing and trial). Enterprise is
// unlimited, modeled as null so callers branch on `unlimited` rather than a
// sentinel number. Subscription is per workspace, so seats are per workspace.

/** The four plan tiers, mirroring workspaces.plan_tier (text in the DB type). */
export const PLAN_TIERS = ['solo', 'studio', 'agency', 'enterprise'] as const;
export type PlanTier = (typeof PLAN_TIERS)[number];

/** Seat allowance per tier. null = unlimited (enterprise). */
export const PLAN_SEAT_LIMITS: Record<PlanTier, number | null> = {
  solo: 1,
  studio: 4,
  agency: 8,
  enterprise: null,
};

export interface SeatUsage {
  /** Active members occupying a seat (floored at 0). */
  used: number;
  /** Seats the plan allows, or null when unlimited. */
  limit: number | null;
  /** Seats still open, or null when unlimited. Floored at 0. */
  remaining: number | null;
  /** True for enterprise (no seat cap). */
  unlimited: boolean;
  /** True when a capped plan has used every seat (no room to invite). */
  atCapacity: boolean;
}

/** Narrow an arbitrary plan_tier string (DB type is `string`) to a known tier. */
export function isPlanTier(value: string): value is PlanTier {
  return (PLAN_TIERS as readonly string[]).includes(value);
}

/** Seat allowance for a tier, or null when unlimited. */
export function seatLimitForPlan(plan: PlanTier): number | null {
  return PLAN_SEAT_LIMITS[plan];
}

/**
 * Derive seat usage for a plan given the workspace's active-member count.
 * Negative counts are clamped to 0; on a capped plan `remaining` never goes
 * below 0 even if the workspace is over its allowance (legacy / downgrade).
 */
export function computeSeatUsage(plan: PlanTier, activeMemberCount: number): SeatUsage {
  const used = Math.max(0, Math.trunc(activeMemberCount));
  const limit = seatLimitForPlan(plan);
  if (limit === null) {
    return { used, limit: null, remaining: null, unlimited: true, atCapacity: false };
  }
  return {
    used,
    limit,
    remaining: Math.max(0, limit - used),
    unlimited: false,
    atCapacity: used >= limit,
  };
}
