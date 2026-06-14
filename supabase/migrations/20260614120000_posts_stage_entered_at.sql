-- Posts stage_entered_at: timestamp of entry into the current stage.
-- Powers the PCS stage header. draft reads updated_at; review/approved/rejected/parked read this.
-- ALREADY APPLIED to movnexawfhsyuluspxoc via Supabase MCP on 2026-06-14.
-- Do NOT execute. Do NOT run `supabase db push`. Recorded for the migration ledger only.

ALTER TABLE public.posts ADD COLUMN stage_entered_at timestamptz;

-- Backfill from updated_at (best proxy for existing rows; exact for every future transition).
-- The row_version enforcement trigger rejects updates that don't bump row_version, so it is
-- disabled for the backfill only -- a backfill is not a logical edit and must not bump row_version.
ALTER TABLE public.posts DISABLE TRIGGER posts_row_version_check;
UPDATE public.posts SET stage_entered_at = updated_at WHERE stage_entered_at IS NULL;
ALTER TABLE public.posts ENABLE TRIGGER posts_row_version_check;

ALTER TABLE public.posts ALTER COLUMN stage_entered_at SET DEFAULT now();
ALTER TABLE public.posts ALTER COLUMN stage_entered_at SET NOT NULL;

-- Stamp stage_entered_at on every transition. One new SET clause; body otherwise identical to the
-- definition in 20260613093000_b_activity_comment_stage_side_effects.sql.
CREATE OR REPLACE FUNCTION public.stage_transition(p_post_id uuid, p_to_stage text, p_trace_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_ws uuid; v_from text; v_cap text; v_ok boolean;
BEGIN
  SELECT workspace_id, stage INTO v_ws, v_from FROM public.posts WHERE id=p_post_id AND deleted_at IS NULL;
  IF v_ws IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF NOT public.is_active_workspace_member(v_ws) THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  v_ok := (v_from='draft'    AND p_to_stage IN ('review','parked'))
       OR (v_from='review'   AND p_to_stage IN ('approved','rejected','parked'))
       OR (v_from='approved' AND p_to_stage IN ('parked','rejected'))
       OR (v_from='parked'   AND p_to_stage='review')
       OR (v_from='rejected' AND p_to_stage='review');
  IF NOT v_ok THEN RAISE EXCEPTION 'invalid_stage_transition'; END IF;
  v_cap := CASE WHEN p_to_stage IN ('approved','rejected') THEN 'post.approve' ELSE 'post.edit' END;
  IF NOT public.proc_capability(v_ws, v_cap) THEN RAISE EXCEPTION 'forbidden_role'; END IF;
  UPDATE public.posts SET stage=p_to_stage, stage_entered_at=now(), row_version=row_version+1 WHERE id=p_post_id;
  PERFORM public.audit_log_write('stage_transition','success',p_trace_id,v_ws,'post',p_post_id::text,
          jsonb_build_object('from',v_from,'to',p_to_stage));
  INSERT INTO public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload)
  SELECT wm.user_id, v_ws, 'stage_change', 'post', p_post_id::text, 'posts', p_post_id::text, 'active',
         jsonb_build_object('from', v_from, 'to', p_to_stage)
  FROM public.workspace_members wm
  WHERE wm.workspace_id=v_ws AND wm.active = true AND wm.user_id <> auth.uid();
  RETURN p_post_id;
END; $$;
