// Edge function: POST /brief-close
//
// Thin HTTP shell over @srtdio/briefs.closeBrief. Authentication and the
// per-request session_devices fingerprint gate are owned by @srtdio/auth
// fingerprintMiddleware (PR 7): on rejection it returns the Response (401/403)
// and we forward it untouched; on success it yields a Supabase client bound to
// the caller's JWT, so the brief_close proc runs as auth.uid(). The proc alone
// decides who may close (brief.close, or brief.close_own on an own brief); this
// shell never re-checks. There is intentionally no edit/update counterpart.
//
// trace_id is read from the X-Trace-Id header and threaded explicitly.

import { fingerprintMiddleware } from '@srtdio/auth';
import { closeBrief, type DomainErrorCode } from '@srtdio/briefs';

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

  const briefId = (parsed as Record<string, unknown> | null)?.briefId;
  if (typeof briefId !== 'string') return json({ error: 'invalid_payload' }, 422);

  const result = await closeBrief(auth.client, { briefId }, traceId);
  if (!result.ok) return json({ error: result.error.code }, statusForError(result.error.code));
  return json({ data: { ok: true } }, 200);
});
