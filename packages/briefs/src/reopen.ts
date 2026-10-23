// reopenBrief: return a closed brief to open. The SECURITY DEFINER
// public.brief_reopen proc owns the policy (any active workspace member, no
// capability check) and the closed -> open guard: it raises invalid_payload for
// a brief that is missing or not closed, and workspace_member_only for a
// non-member. This wrapper does NOT re-check either; like closeBrief it is the
// single status transition, never an edit path.

import { briefReopen, type Client, type Result } from '@srtdio/rpc';

export interface ReopenBriefInput {
  briefId: string;
}

export function reopenBrief(
  client: Client,
  input: ReopenBriefInput,
  traceId: string,
): Promise<Result<void>> {
  return briefReopen(client, { p_brief_id: input.briefId, p_trace_id: traceId });
}
