// Friendly, inline copy for a failed stage_transition. The proc owns the policy:
// it raises forbidden_role when the role lacks approve/reject capability and
// invalid_stage_transition for an illegal move. Shared by the post detail page
// and the chat post sheet so both surfaces word a failure the same way, in the
// shared "Couldn't {action}. {reason}" shape.

import type { DomainError } from '@srtdio/rpc';
import { errorText } from '@/lib/error-copy';

export function friendlyTransitionError(error: DomainError, action = 'move the post'): string {
  if (error.code === 'invalid_stage_transition') {
    return `Couldn't ${action}. That move isn't allowed from its current stage.`;
  }
  return errorText(action, error);
}
