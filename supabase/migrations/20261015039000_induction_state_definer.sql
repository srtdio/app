-- induction_state: SECURITY DEFINER so it can read the caller's own user_private row.
-- As SECURITY INVOKER it failed for every signed-in user ("permission denied for table
-- user_private": authenticated holds no SELECT on that table), so the app read the
-- induction as done and the guide never showed. Workspace fields (role, post_id,
-- client_invited, team_invited) are returned only to an active member of p_workspace_id.
-- Applied to v2 (movnexawfhsyuluspxoc) via Supabase MCP on 15 Oct 2026 after Shubham's
-- approval; body copied verbatim from live. EXECUTE grants unchanged (authenticated only).
CREATE OR REPLACE FUNCTION public.induction_state(p_workspace_id uuid, p_trace_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  WITH me AS (
    SELECT role FROM public.workspace_members
    WHERE workspace_id = p_workspace_id AND user_id = auth.uid() AND active
  )
  SELECT jsonb_build_object(
    'step',    (SELECT induction_step    FROM public.user_private WHERE user_id = auth.uid()),
    'done_at', (SELECT induction_done_at FROM public.user_private WHERE user_id = auth.uid()),
    'role',    (SELECT role FROM me),
    'post_id', (SELECT id FROM public.posts
                 WHERE EXISTS (SELECT 1 FROM me)
                   AND workspace_id = p_workspace_id AND created_by = auth.uid()
                   AND stage <> 'draft' AND deleted_at IS NULL
                 ORDER BY created_at LIMIT 1),
    'client_invited', EXISTS (SELECT 1 FROM me) AND EXISTS (
                 SELECT 1 FROM public.workspace_members
                 WHERE workspace_id = p_workspace_id AND role = 'client' AND removed_at IS NULL),
    'team_invited',   EXISTS (SELECT 1 FROM me) AND EXISTS (
                 SELECT 1 FROM public.workspace_members
                 WHERE workspace_id = p_workspace_id AND role IN ('admin','agency') AND removed_at IS NULL)
  );
$function$;

REVOKE EXECUTE ON FUNCTION public.induction_state(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.induction_state(uuid, uuid) TO authenticated;
