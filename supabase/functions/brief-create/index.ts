// Edge function: POST /brief-create
//
// Thin HTTP shell over @srtdio/briefs.createBrief. Authentication and the
// per-request session_devices fingerprint gate are owned by @srtdio/auth
// fingerprintMiddleware (PR 7): on rejection it returns the Response (401/403)
// and we forward it untouched; on success it yields a Supabase client bound to
// the caller's JWT, so the brief_create proc runs as auth.uid() under RLS.
//
// trace_id is read from the X-Trace-Id header (the frontend is its source of
// truth) and threaded explicitly into the wrapper, never inferred downstream.

import { fingerprintMiddleware } from '@srtdio/auth';
import { createBrief, type CreateBriefInput, type DomainErrorCode } from '@srtdio/briefs';

const TRACE_HEADER = 'X-Trace-Id';
const JSON_HEADERS = { 'content-type': 'application/json' } as const;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function statusForError(code: DomainErrorCode): number {
  switch (code) {
    case 'forbidden_role':
    case 'workspace_member_only':
      return 403;
    case 'invalid_payload':
      return 422;
    default:
      return 500;
  }
}

/** Pull the createBrief input out of an untrusted JSON body, or null if invalid. */
function readInput(body: unknown): CreateBriefInput | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (
    typeof b.workspaceId !== 'string' ||
    typeof b.title !== 'string' ||
    typeof b.objective !== 'string'
  ) {
    return null;
  }
  const input: CreateBriefInput = {
    workspaceId: b.workspaceId,
    title: b.title,
    objective: b.objective,
  };
  if (typeof b.formatRequested === 'string') input.formatRequested = b.formatRequested;
  if (typeof b.brandRequirements === 'string') input.brandRequirements = b.brandRequirements;
  if (typeof b.targetDate === 'string') input.targetDate = b.targetDate;
  if (b.referenceLinks !== undefined)
    input.referenceLinks = b.referenceLinks as CreateBriefInput['referenceLinks'];
  if (b.attachmentAssetVersionIds !== undefined) {
    // Optional ordered asset_version ids. Reject anything that is not an array of
    // non-empty strings; the proc re-validates uuid shape and workspace ownership.
    if (
      !Array.isArray(b.attachmentAssetVersionIds) ||
      !b.attachmentAssetVersionIds.every((v) => typeof v === 'string' && v.length > 0)
    ) {
      return null;
    }
    input.attachmentAssetVersionIds = b.attachmentAssetVersionIds;
  }
  if (typeof b.initialCommentBody === 'string') input.initialCommentBody = b.initialCommentBody;
  return input;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const auth = await fingerprintMiddleware(req);
  if (!auth.ok) return auth.response;

  const traceId = req.headers.get(TRACE_HEADER) ?? auth.traceId;

  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const input = readInput(parsed);
  if (input === null) return json({ error: 'invalid_payload' }, 422);

  const result = await createBrief(auth.client, input, traceId);
  if (!result.ok) return json({ error: result.error.code }, statusForError(result.error.code));
  return json({ data: result.data }, 201);
});
