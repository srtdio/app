// postVersionCreate: append a new immutable version (v2+) to an existing post.
// Version 1 is created by post_create itself, so this is the edit path only.
// public.post_version_create owns the version_number sequence and the
// append-only guarantee (post_versions has no deleted_at); this wrapper just
// shapes the call and threads the trace_id.

import { postVersionCreate as postVersionCreateRpc, type Client, type Result } from '@srtdio/rpc';
import type { Json } from '@srtdio/schemas';
import { resolveTraceId } from './trace';

export interface PostVersionCreateInput {
  postId: string;
  /** The full content snapshot for this version, as the proc stores it. */
  snapshot: Json;
  /** Optional; a uuid_v7 is minted at entry when omitted. */
  traceId?: string;
}

export function postVersionCreate(
  client: Client,
  input: PostVersionCreateInput,
): Promise<Result<string>> {
  return postVersionCreateRpc(client, {
    p_post_id: input.postId,
    p_snapshot: input.snapshot,
    p_trace_id: resolveTraceId(input.traceId),
  });
}
