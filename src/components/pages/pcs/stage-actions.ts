// The role-gated stage rail. The SET of transition targets comes only from the
// authoritative STAGE_TRANSITIONS map (never re-decided here); this layer maps
// each legal target to a labelled button and decides VISIBILITY per role so the
// client only ever sees Approve / Reject and the agency side only ever
// sees Park / Send-or-move to review. This mirrors the server exactly: it never
// surfaces a button the stage_transition proc would reject. Pure, unit-tested.

import { STAGE_TRANSITIONS, type Stage } from '@srtdio/posts';
import { isAgencySide, isClient } from '@/components/pages/pcs/roles';

/** One rendered stage button: its target stage, its label, and its emphasis. */
export interface StageAction {
  to: Stage;
  label: string;
  variant: 'primary' | 'default' | 'danger';
}

/**
 * The buttons a viewer in `role` may press from `stage`. Walks the legal targets
 * in map order and keeps only the ones this role is allowed to trigger:
 *   approved  -> "Approve"          (client only)
 *   rejected  -> "Reject"           (client only)
 *   parked    -> "Park"             (agency side only)
 *   review    -> "Send for review" from draft, "Move to review" otherwise (agency)
 * An unknown role keeps nothing, so the caller falls back to a read-only status.
 */
export function visibleStageActions(stage: Stage, role: string | null): StageAction[] {
  const targets = STAGE_TRANSITIONS[stage] as readonly Stage[];
  const out: StageAction[] = [];
  for (const to of targets) {
    if (to === 'approved' && isClient(role)) {
      out.push({ to, label: 'Approve', variant: 'primary' });
    } else if (to === 'rejected' && isClient(role)) {
      out.push({ to, label: 'Reject', variant: 'danger' });
    } else if (to === 'parked' && isAgencySide(role)) {
      out.push({ to, label: 'Park', variant: 'default' });
    } else if (to === 'review' && isAgencySide(role)) {
      out.push({
        to,
        label: stage === 'draft' ? 'Send for review' : 'Move to review',
        variant: 'primary',
      });
    }
  }
  return out;
}
