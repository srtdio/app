-- Applied to movnexawfhsyuluspxoc via Supabase MCP on 23 Oct 2026. Read-only: latest invite email status (sent/delivered/bounced) per pending invite, for active workspace members only.

CREATE OR REPLACE FUNCTION public.invite_delivery_list(p_workspace_id uuid)
 RETURNS TABLE(member_id uuid, status text, status_at timestamptz)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $function$
  SELECT DISTINCT ON (m.id) m.id, d.status,
         coalesce(d.bounced_at, d.delivered_at, d.sent_at, d.created_at)
    FROM public.workspace_members m
    JOIN public.delivery_attempts d
      ON d.workspace_id = m.workspace_id AND d.user_id = m.user_id
     AND d.template_key = 'member_invite' AND d.created_at >= m.invited_at
   WHERE m.workspace_id = p_workspace_id
     AND m.active = false AND m.accepted_at IS NULL AND m.removed_at IS NULL
     AND public.is_active_workspace_member(p_workspace_id)
   ORDER BY m.id, d.created_at DESC
$function$;
REVOKE ALL ON FUNCTION public.invite_delivery_list(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.invite_delivery_list(uuid) TO authenticated;
