// The post workflow stage machine. `post.stage` is the single workflow state
// (draft, review, approved, parked, rejected); this module is the typed client
// view of the transition map. The map is authoritative server-side as a matrix
// CHECK plus the stage_transition SECURITY DEFINER proc, so canTransition() here
// is a pure mirror for UI gating, NOT the enforcement point. stageTransition()
// is the typed wrapper around the proc and never re-decides legality.

import { stageTransition as stageTransitionRpc, type Client, type Result } from '@srtdio/rpc';
import { resolveTraceId } from './trace';

/** The five workflow stages. There is no `publish_status`; stage is the state. */
export type Stage = 'draft' | 'review' | 'approved' | 'parked' | 'rejected';

/**
 * The locked transition map. `approved` is deliberately NOT terminal: an
 * approved post may still be parked or rejected. Keep in lockstep with the DB
 * matrix CHECK; this is the same map, expressed for the client.
 */
export const STAGE_TRANSITIONS = {
  draft: ['review', 'parked'],
  review: ['approved', 'rejected', 'parked'],
  approved: ['parked', 'rejected'],
  parked: ['review'],
  rejected: ['review'],
} as const satisfies Readonly<Record<Stage, readonly Stage[]>>;

/** Pure legality check against {@link STAGE_TRANSITIONS}. No I/O. */
export function canTransition(from: Stage, to: Stage): boolean {
  return (STAGE_TRANSITIONS[from] as readonly Stage[]).includes(to);
}

export interface StageTransitionInput {
  postId: string;
  toStage: Stage;
  /** Optional; a uuid_v7 is minted at entry when omitted. */
  traceId?: string;
}

/**
 * Move a post to `toStage` via public.stage_transition. The proc owns the
 * policy and the legality guard (it raises invalid_stage_transition / forbidden
 * for an illegal or unauthorised move); this wrapper only shapes the call.
 */
export function stageTransition(
  client: Client,
  input: StageTransitionInput,
): Promise<Result<string>> {
  return stageTransitionRpc(client, {
    p_post_id: input.postId,
    p_to_stage: input.toStage,
    p_trace_id: resolveTraceId(input.traceId),
  });
}
