// The reject reason as a comment, written the way the post page writes it
// (PostDetailPage's createAnchoredComment): an approver's comment goes through
// the comment batch proc, everyone else's through createComment. Both carry
// the move's trace id. Never throws; a failure is { ok: false }.

import { createComment } from '@srtdio/comments';
import { runCreateCommentBatch } from '@/components/comments/Comments';
import { isClient } from '@/components/pages/pcs/roles';
import type { Client } from '@srtdio/posts';

export interface StageReasonInput {
  workspaceId: string;
  postId: string;
  body: string;
  traceId: string;
  role: string | null;
}

export async function postStageReason(
  client: Client,
  input: StageReasonInput,
): Promise<{ ok: boolean }> {
  try {
    if (isClient(input.role)) {
      const batch = await runCreateCommentBatch(client, {
        workspaceId: input.workspaceId,
        postId: input.postId,
        points: [{ body: input.body }],
        traceId: input.traceId,
      });
      return { ok: batch.ok };
    }
    const result = await createComment(client, {
      workspace_id: input.workspaceId,
      entity_type: 'post',
      entity_id: input.postId,
      body: input.body,
      trace_id: input.traceId,
    });
    return { ok: result.ok };
  } catch {
    return { ok: false };
  }
}
