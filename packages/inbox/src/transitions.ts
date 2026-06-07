// Pure predicates that decide whether a Realtime change is a fan-out trigger.
// Kept separate so both the envelope builder and the recipient computation read
// the same definition of "actionable" and can never drift apart.

import type { ChangeEvent, InboxTier } from './types';

/** posts UPDATE: stage actually changed (pre-image present and different). */
export function stageChanged(
  event: Extract<ChangeEvent, { table: 'posts'; type: 'UPDATE' }>,
): boolean {
  return event.old.stage !== undefined && event.old.stage !== event.row.stage;
}

/** comments UPDATE: is_decision flipped from not-true to true. */
export function decisionFlipped(
  event: Extract<ChangeEvent, { table: 'comments'; type: 'UPDATE' }>,
): boolean {
  return event.old.is_decision !== true && event.row.is_decision === true;
}

/** briefs UPDATE: status transitioned into 'closed'. */
export function briefClosed(
  event: Extract<ChangeEvent, { table: 'briefs'; type: 'UPDATE' }>,
): boolean {
  return event.old.status !== 'closed' && event.row.status === 'closed';
}

/** A stage change to approved/rejected is urgent; everything else is active. */
export function stageTier(toStage: string): InboxTier {
  return toStage === 'approved' || toStage === 'rejected' ? 'urgent' : 'active';
}

/** Whether the change is a fan-out trigger at all. Mirrors the EVENT MAP. */
export function isActionable(event: ChangeEvent): boolean {
  switch (event.table) {
    case 'comments':
      return event.type === 'INSERT' || decisionFlipped(event);
    case 'posts':
      return stageChanged(event);
    case 'briefs':
      return event.type === 'INSERT' || briefClosed(event);
    case 'assets':
      return true;
    case 'asset_versions':
      return event.row.version_number > 1;
    case 'workspace_members':
      return event.row.active === false;
  }
}
