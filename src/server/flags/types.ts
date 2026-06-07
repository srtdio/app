// Shared types, enumerations, and validators for the feature-flag module.
//
// Every enumerated value mirrors a CHECK constraint on public.feature_flags
// (see docs/schema.md section 9). Keeping them here, derived from a single
// `as const` tuple, means the runtime validators in setFlag and the static
// types used across the module can never drift apart.

export const FLAG_CATEGORIES = ['killswitch', 'rollout', 'experiment', 'tier_gated'] as const;
export type FlagCategory = (typeof FLAG_CATEGORIES)[number];

export const PLAN_TIERS = ['solo', 'studio', 'agency', 'enterprise'] as const;
export type PlanTier = (typeof PLAN_TIERS)[number];

// Mirrors feature_flags_rollout_percentage_check.
export const ROLLOUT_PERCENTAGES = [0, 10, 25, 50, 100] as const;
export type RolloutPercentage = (typeof ROLLOUT_PERCENTAGES)[number];

// Mirrors feature_flags_flag_name_check.
export const FLAG_NAME_PATTERN = /^[a-z][a-z0-9_]{0,99}$/;

// Plan-tier ordering for tier_gated evaluation. Higher rank = more access.
export const TIER_RANK: Record<PlanTier, number> = {
  solo: 0,
  studio: 1,
  agency: 2,
  enterprise: 3,
};

/** Which row supplied an effective flag: the workspace override or the global default. */
export type FlagSource = 'workspace' | 'global';

/** Result of evaluating a single flag for a principal. */
export interface EvalResult {
  enabled: boolean;
  reason: string;
}

/** One entry in the merged effective set returned by listFlags. */
export interface EffectiveFlag {
  flagName: string;
  category: FlagCategory;
  enabled: boolean;
  rolloutPercentage: number;
  tierMin: PlanTier | null;
  reason: string | null;
  source: FlagSource;
}

export function isFlagCategory(value: string): value is FlagCategory {
  return (FLAG_CATEGORIES as readonly string[]).includes(value);
}

export function isPlanTier(value: string): value is PlanTier {
  return (PLAN_TIERS as readonly string[]).includes(value);
}

export function isRolloutPercentage(value: number): value is RolloutPercentage {
  return (ROLLOUT_PERCENTAGES as readonly number[]).includes(value);
}
