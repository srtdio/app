// closeBrief: flip an open brief to closed. The SECURITY DEFINER
// public.brief_close proc owns the policy (brief.close, or brief.close_own on a
// brief the caller created) and the open -> closed guard; this wrapper does NOT
// re-check who may close. There is intentionally no update path: a brief has no
// editable fields after creation, only this single status transition.

import { briefClose, type Client, type Result } from '@srtdio/rpc';

export interface CloseBriefInput {
  briefId: string;
}

export function closeBrief(
  client: Client,
  input: CloseBriefInput,
  traceId: string,
): Promise<Result<void>> {
  return briefClose(client, { p_brief_id: input.briefId, p_trace_id: traceId });
}
