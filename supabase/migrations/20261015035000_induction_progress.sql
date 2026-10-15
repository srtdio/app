-- Induction 6/7: per-user induction progress in user_private, plus the procs that read and write it.
-- Applied to v2 (movnexawfhsyuluspxoc) via Supabase MCP on 15 Oct 2026; bodies copied verbatim from live.
ALTER TABLE public.user_private ADD COLUMN IF NOT EXISTS induction_step text;
ALTER TABLE public.user_private ADD COLUMN IF NOT EXISTS induction_done_at timestamptz;

ALTER TABLE public.user_private DROP CONSTRAINT IF EXISTS user_private_induction_step_format;
ALTER TABLE public.user_private ADD CONSTRAINT user_private_induction_step_format
  CHECK (((induction_step IS NULL) OR (induction_step ~ '^[a-z0-9_]{1,40}$'::text)));

-- DESTRUCTIVE: constraint swap only, no row or column dropped. Rollback: re-add the previous constraint text:
-- CHECK (((heard_from IS NULL) OR (heard_from = ANY (ARRAY['friend'::text, 'instagram'::text, 'linkedin'::text, 'google'::text, 'client'::text, 'other'::text]))))
ALTER TABLE public.user_private DROP CONSTRAINT IF EXISTS user_private_heard_from_check;
ALTER TABLE public.user_private ADD CONSTRAINT user_private_heard_from_check
  CHECK (((heard_from IS NULL) OR (heard_from = ANY (ARRAY['friend'::text, 'ad'::text, 'instagram'::text, 'linkedin'::text, 'google'::text, 'client'::text, 'other'::text]))));

CREATE OR REPLACE FUNCTION public.induction_step_set(p_step text, p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'unauthenticated'; END IF;
  IF p_step IS NULL OR p_step !~ '^[a-z0-9_]{1,40}$' THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  INSERT INTO public.user_private (user_id, induction_step, updated_at)
  VALUES (auth.uid(), p_step, now())
  ON CONFLICT (user_id) DO UPDATE SET induction_step = excluded.induction_step, updated_at = now();
  PERFORM public.audit_log_write('induction_step_set','success',p_trace_id,NULL,'user',auth.uid()::text,
    jsonb_build_object('step',p_step));
END; $function$;

CREATE OR REPLACE FUNCTION public.induction_finish(p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'unauthenticated'; END IF;
  INSERT INTO public.user_private (user_id, induction_done_at, updated_at)
  VALUES (auth.uid(), now(), now())
  ON CONFLICT (user_id) DO UPDATE SET induction_done_at = coalesce(public.user_private.induction_done_at, now()), updated_at = now();
  PERFORM public.audit_log_write('induction_finish','success',p_trace_id,NULL,'user',auth.uid()::text,NULL);
END; $function$;

CREATE OR REPLACE FUNCTION public.induction_state(p_workspace_id uuid, p_trace_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  SELECT jsonb_build_object(
    'step',        (SELECT induction_step FROM public.user_private WHERE user_id = auth.uid()),
    'done_at',     (SELECT induction_done_at FROM public.user_private WHERE user_id = auth.uid()),
    'role',        (SELECT role FROM public.workspace_members
                     WHERE workspace_id = p_workspace_id AND user_id = auth.uid() AND active),
    'post_id',     (SELECT id FROM public.posts
                     WHERE workspace_id = p_workspace_id AND created_by = auth.uid()
                       AND stage <> 'draft' AND deleted_at IS NULL
                     ORDER BY created_at LIMIT 1),
    'client_invited', EXISTS (SELECT 1 FROM public.workspace_members
                     WHERE workspace_id = p_workspace_id AND role = 'client' AND removed_at IS NULL),
    'team_invited',   EXISTS (SELECT 1 FROM public.workspace_members
                     WHERE workspace_id = p_workspace_id AND role IN ('admin','agency') AND removed_at IS NULL)
  );
$function$;

REVOKE EXECUTE ON FUNCTION public.induction_step_set(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.induction_step_set(text, uuid) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.induction_finish(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.induction_finish(uuid) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.induction_state(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.induction_state(uuid, uuid) TO authenticated;

-- Backfill: users who finished onboarding before induction existed skip it.
INSERT INTO public.user_private (user_id, induction_done_at, updated_at)
SELECT id, now(), now() FROM public.users WHERE profile_completed_at IS NOT NULL
ON CONFLICT (user_id) DO UPDATE SET induction_done_at = coalesce(public.user_private.induction_done_at, now());
