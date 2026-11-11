// "Send for review again": the post_ready_notify call with its error mapping
// (use-post-decisions). The old notice panel, its send history and its
// open-points gate are gone (11 Nov 2026: comments are a chat, nothing to
// resolve before a send).

import { DOMAIN_ERROR_CODES } from '@srtdio/rpc';
import type { Client, DomainErrorCode, Result } from '@srtdio/rpc';

/** Call post_ready_notify: a raised domain code maps to itself, anything else
 *  to 'unknown', both carrying the raw message. */
export async function runPostReadyNotify(
  client: Client,
  params: { postId: string; traceId: string },
): Promise<Result<undefined>> {
  const args = { p_post_id: params.postId, p_trace_id: params.traceId };
  const { error } = await client.rpc('post_ready_notify', args);
  if (error) {
    const known = (DOMAIN_ERROR_CODES as readonly string[]).includes(error.message);
    return {
      ok: false,
      error: {
        code: known ? (error.message as DomainErrorCode) : 'unknown',
        message: error.message,
      },
    };
  }
  return { ok: true, data: undefined };
}
