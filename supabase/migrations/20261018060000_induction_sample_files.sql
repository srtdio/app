-- The sample week's files ship with the app (public/induction-sample/), so the
-- client shows them from the site's static path without an asset-read round trip.
-- It needs each sample version's key, including chat ones (asset_versions RLS
-- shows library assets only). Member-only, read-only, sample keys only.
--
-- Applied to v2 (movnexawfhsyuluspxoc) via Supabase MCP at Shubham's request.

CREATE OR REPLACE FUNCTION public.induction_sample_files(p_workspace_id uuid, p_trace_id uuid)
 RETURNS TABLE(id uuid, r2_key text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT v.id, v.r2_key
    FROM public.asset_versions v
   WHERE v.workspace_id = p_workspace_id
     AND v.r2_key LIKE 'induction-sample/%'
     AND p_trace_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.workspace_members wm
                  WHERE wm.workspace_id = p_workspace_id AND wm.user_id = auth.uid()
                    AND wm.active AND wm.removed_at IS NULL);
$function$;
REVOKE EXECUTE ON FUNCTION public.induction_sample_files(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.induction_sample_files(uuid, uuid) TO authenticated;
