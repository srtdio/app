// Feature-flag read/write/eval module (Phase 1 backend).
//
// Public surface:
//   - evalFlag:  resolve + evaluate one flag for a principal.
//   - setFlag:   create/update a flag row (service-role) and audit it.
//   - listFlags: merged effective set (workspace overrides over global).
//   - createFlagsServiceClient: build the service-role client from env config.

export { evalFlag, type EvalFlagInput } from './evalFlag';
export { setFlag, FlagValidationError, type SetFlagInput } from './setFlag';
export { listFlags, type ListFlagsInput } from './listFlags';
export { createFlagsServiceClient, type FlagsServiceEnv } from './client';
export { bucketFor } from './bucket';
export {
  FLAG_CATEGORIES,
  PLAN_TIERS,
  ROLLOUT_PERCENTAGES,
  FLAG_NAME_PATTERN,
  TIER_RANK,
  isFlagCategory,
  isPlanTier,
  isRolloutPercentage,
  type FlagCategory,
  type PlanTier,
  type RolloutPercentage,
  type FlagSource,
  type EvalResult,
  type EffectiveFlag,
} from './types';
