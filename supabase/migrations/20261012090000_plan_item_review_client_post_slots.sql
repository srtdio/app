-- plan_item_review: client post slots, draft refusal, withdrawal entry.
-- Applied live on movnexawfhsyuluspxoc (12 Oct); this file records the body
-- verbatim (pg_get_functiondef md5 9f4a001b38f2a9ada86b66d60e59f0cc).
--   * post items: 'invalid_payload' when the post is missing or soft-deleted.
--   * client side on a post item is allowed on a client plan; a draft post is
--     'post_not_ready'; a team plan stays 'forbidden_role'. posts.stage is
--     never written.
--   * approved/changes notify through _plan_item_notify (payload side, status).
--   * waiting after approved/changes adds a NEW plan_review entry
--     {side, status:'waiting', withdrawn:true, previous}; the earlier entry stays.
-- Rollback: re-apply the previous body (md5 7c68e270cf5999cd5cb8a768c795ed4b).

CREATE OR REPLACE FUNCTION public.plan_item_review(p_item_id uuid, p_side text, p_status text, p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ws uuid; v_kind text; v_aud text; v_post uuid; v_stage text; v_post_gone boolean; v_prev text;
begin
  select i.workspace_id, i.kind, p.audience, i.post_id into v_ws, v_kind, v_aud, v_post
    from public.plan_items i join public.plans p on p.id = i.plan_id
   where i.id = p_item_id and i.deleted_at is null and p.deleted_at is null
   for update of i;
  if v_ws is null then raise exception 'invalid_payload'; end if;
  if p_side not in ('team','client') or p_status not in ('waiting','approved','changes') then raise exception 'invalid_payload'; end if;
  if v_kind = 'post' then
    select po.stage, po.deleted_at is not null into v_stage, v_post_gone from public.posts po where po.id = v_post;
    if v_stage is null or v_post_gone then raise exception 'invalid_payload'; end if;
  end if;
  if p_side = 'team' then
    if not public.is_agency_side_member(v_ws) then raise exception 'forbidden_role'; end if;
  else
    if not exists (select 1 from public.workspace_members wm
                    where wm.workspace_id = v_ws and wm.user_id = auth.uid() and wm.active = true and wm.role = 'client') then
      raise exception 'forbidden_role'; end if;
    if v_aud <> 'client' then raise exception 'forbidden_role'; end if;
    if v_kind = 'post' and v_stage = 'draft' then raise exception 'post_not_ready'; end if;
  end if;
  select r.status into v_prev from public.plan_item_reviews r where r.item_id = p_item_id and r.side = p_side;
  insert into public.plan_item_reviews (item_id, workspace_id, side, status, reviewed_by, reviewed_at)
  values (p_item_id, v_ws, p_side, p_status, auth.uid(), now())
  on conflict (item_id, side) do update
    set status = excluded.status, reviewed_by = excluded.reviewed_by, reviewed_at = excluded.reviewed_at;
  if p_status <> 'waiting' then
    perform public._plan_item_notify(p_item_id, 'plan_review', p_side = 'team',
      jsonb_build_object('side', p_side, 'status', p_status));
  elsif v_prev is not null and v_prev <> 'waiting' then
    perform public._plan_item_notify(p_item_id, 'plan_review', p_side = 'team',
      jsonb_build_object('side', p_side, 'status', 'waiting', 'withdrawn', true, 'previous', v_prev));
  end if;
  perform public.audit_log_write(p_action=>'plan_item_review', p_outcome=>'success', p_trace_id=>p_trace_id,
    p_workspace_id=>v_ws, p_entity_type=>'plan_item', p_entity_id=>p_item_id::text,
    p_payload=>jsonb_build_object('side', p_side, 'status', p_status, 'kind', v_kind));
end $function$
;
