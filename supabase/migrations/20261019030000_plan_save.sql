-- Applied out of band 19 Oct 2026 on movnexawfhsyuluspxoc. No-op there; recorded for fresh databases.
--
-- Plan edit mode's one write: plan_save runs the queued ops of a Save changes
-- (update, remove, move, reorder) through the existing plan_update,
-- plan_item_remove, plan_item_move (5-arg) and plan_items_reorder, in order,
-- in ONE transaction: all or nothing, their errors pass through
-- (forbidden_role, invalid_payload, date_outside_plan). p_ops is an array of
-- 1 to 200 ops. Function body is verbatim pg_get_functiondef from live.
--
-- Rollback: drop function public.plan_save(uuid, jsonb, uuid);

CREATE OR REPLACE FUNCTION public.plan_save(p_plan_id uuid, p_ops jsonb, p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_op jsonb;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if jsonb_typeof(p_ops) <> 'array' or jsonb_array_length(p_ops) not between 1 and 200 then raise exception 'invalid_payload'; end if;
  for v_op in select * from jsonb_array_elements(p_ops) loop
    case v_op->>'op'
      when 'update'  then perform public.plan_update(p_plan_id, v_op->>'title', (v_op->>'starts_on')::date, (v_op->>'ends_on')::date, p_trace_id);
      when 'remove'  then perform public.plan_item_remove((v_op->>'item_id')::uuid, p_trace_id);
      when 'move'    then perform public.plan_item_move((v_op->>'item_id')::uuid, (v_op->>'target_date')::date,
                            array(select jsonb_array_elements_text(v_op->'item_ids'))::uuid[], coalesce((v_op->>'keep_reviews')::boolean, true), p_trace_id);
      when 'reorder' then perform public.plan_items_reorder(p_plan_id, array(select jsonb_array_elements_text(v_op->'item_ids'))::uuid[], p_trace_id);
      else raise exception 'invalid_payload';
    end case;
  end loop;
end $function$;

revoke all on function public.plan_save(uuid,jsonb,uuid) from public, anon;
grant execute on function public.plan_save(uuid,jsonb,uuid) to authenticated;
