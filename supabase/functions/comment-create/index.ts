// Edge function: POST /comment-create.
//
// Authenticates the caller from the inbound JWT, runs the session-device
// fingerprint gate (fingerprintMiddleware, PR 7), then delegates to
// @srtdio/comments createComment. createComment validates @[user_id] mentions
// against active workspace membership before invoking the comment_create proc.
//
// trace_id is read from the X-Trace-Id header and propagated explicitly to the
// proc; it is never inferred. The function does no direct table writes: the
// authenticated role reaches the comments table only through the SECURITY
// DEFINER proc.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { fingerprintMiddleware } from '@srtdio/auth';
import { createComment, type CommentEntityType } from '@srtdio/comments';

interface CommentCreateRequestBody {
  workspace_id?: string;
  entity_type?: CommentEntityType;
  entity_id?: string;
  parent_comment_id?: string | null;
  body?: string;
  mentions?: string[];
  attachment_asset_ids?: string[];
  is_decision?: boolean;
}

function jsonResponse(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') {
    return jsonResponse({ error: { code: 'method_not_allowed' } }, 405);
  }

  const traceId = req.headers.get('X-Trace-Id');
  if (!traceId) {
    return jsonResponse({ error: { code: 'missing_trace_id' } }, 400);
  }

  const authorization = req.headers.get('Authorization');
  if (!authorization) {
    return jsonResponse({ error: { code: 'unauthorized' } }, 401);
  }

  // RLS-scoped client bound to the caller's JWT. SECURITY DEFINER procs and RLS
  // do the authorization; this function never uses the service-role key.
  const client = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    {
      global: { headers: { Authorization: authorization } },
      auth: { autoRefreshToken: false, persistSession: false },
    },
  );

  const gate = await fingerprintMiddleware(req, client, traceId);
  if (!gate.ok) {
    return jsonResponse({ error: { code: gate.error } }, gate.status);
  }

  let parsed: CommentCreateRequestBody;
  try {
    parsed = (await req.json()) as CommentCreateRequestBody;
  } catch {
    return jsonResponse({ error: { code: 'invalid_json' } }, 400);
  }

  if (
    !parsed.workspace_id ||
    (parsed.entity_type !== 'post' && parsed.entity_type !== 'brief') ||
    !parsed.entity_id ||
    !parsed.body
  ) {
    return jsonResponse({ error: { code: 'invalid_payload' } }, 400);
  }

  const result = await createComment(client, {
    workspace_id: parsed.workspace_id,
    entity_type: parsed.entity_type,
    entity_id: parsed.entity_id,
    parent_comment_id: parsed.parent_comment_id ?? null,
    body: parsed.body,
    mentions: parsed.mentions ?? [],
    attachment_asset_ids: parsed.attachment_asset_ids ?? [],
    is_decision: parsed.is_decision ?? false,
    trace_id: traceId,
  });

  if (!result.ok) {
    const status =
      result.error.code === 'invalid_mention' || result.error.code === 'invalid_payload'
        ? 400
        : result.error.code === 'workspace_member_only' || result.error.code === 'forbidden_role'
          ? 403
          : 500;
    return jsonResponse({ error: result.error }, status);
  }

  return jsonResponse({ id: result.data }, 201);
});
