-- DESTRUCTIVE tag: two check constraints are dropped and re-added wider in the same statement. No row changes.
-- Rollback: re-add the old checks (valid while no files-only plan comment and no plan_item_comment attachment exists),
-- alter the policy back without the plan_item_comment branch, restore asset_in_use, drop comment_threads_for_me_all.

alter table public.plan_item_comments
  drop constraint plan_item_comments_body_check,
  add constraint plan_item_comments_body_check check (
    char_length(btrim(body)) <= 5000
    and (char_length(btrim(body)) >= 1 or coalesce(array_length(attachment_asset_ids, 1), 0) >= 1));

alter table public.asset_attachments
  drop constraint asset_attachments_entity_type_check,
  add constraint asset_attachments_entity_type_check check (
    entity_type = any (array['post','comment','chat_message','brief','plan_item','plan_item_comment']));

alter policy asset_attachments_select_member on public.asset_attachments
  using (
    deleted_at is null
    and exists (select 1 from public.workspace_members wm
                 where wm.workspace_id = asset_attachments.workspace_id
                   and wm.user_id = (select auth.uid()) and wm.active = true)
    and case entity_type
      when 'post' then exists (select 1 from public.posts p where p.id = (asset_attachments.entity_id)::uuid)
      when 'brief' then exists (select 1 from public.briefs b where b.id = (asset_attachments.entity_id)::uuid)
      when 'comment' then exists (select 1 from public.comments c where c.id = (asset_attachments.entity_id)::uuid)
      when 'plan_item' then exists (select 1 from public.plan_items pi where pi.id = (asset_attachments.entity_id)::uuid)
      when 'plan_item_comment' then exists (select 1 from public.plan_item_comments pc where pc.id = (asset_attachments.entity_id)::uuid)
      else true
    end);

create or replace function public.asset_in_use(p_asset_id uuid)
returns boolean
language sql stable security definer set search_path to ''
as $function$
  select exists (
    select 1 from public.asset_attachments aa
    where aa.asset_id = p_asset_id and aa.deleted_at is null
      and (
        (aa.entity_type = 'post'    and exists (select 1 from public.posts x    where x.id::text = aa.entity_id and x.deleted_at is null))
     or (aa.entity_type = 'brief'   and exists (select 1 from public.briefs x   where x.id::text = aa.entity_id and x.deleted_at is null))
     or (aa.entity_type = 'comment' and exists (select 1 from public.comments x where x.id::text = aa.entity_id and x.deleted_at is null))
     or (aa.entity_type = 'plan_item_comment' and exists (select 1 from public.plan_item_comments x where x.id::text = aa.entity_id and x.deleted_at is null))
      ));
$function$;

create or replace function public.comment_threads_for_me_all(p_workspace_id uuid, p_trace_id uuid)
returns table(
  kind text, entity_type text, entity_id uuid, root_comment_id uuid,
  reply_count bigint, last_reply_at timestamptz, last_reply_id uuid,
  last_reply_author uuid, last_reply_body text, unread boolean)
language plpgsql stable security invoker set search_path to ''
as $function$
#variable_conflict use_column
declare v_actor uuid := auth.uid(); v_tag text;
begin
  if v_actor is null then raise exception 'not authenticated'; end if;
  perform set_config('app.trace_id', coalesce(p_trace_id::text, ''), true);
  if not public.is_active_workspace_member(p_workspace_id) then
    raise exception 'not a member of this workspace'; end if;
  v_tag := '@[' || v_actor::text || ']';
  return query
  with cr as (
    select c.parent_comment_id as root_id, count(*) as n, max(c.created_at) as last_at
      from public.comments c
     where c.workspace_id = p_workspace_id and c.parent_comment_id is not null
       and c.deleted_at is null and c.created_at > now() - interval '90 days'
     group by c.parent_comment_id
  ), cl as (
    select distinct on (c.parent_comment_id) c.parent_comment_id as root_id, c.id, c.author_user_id, left(c.body, 140) as body
      from public.comments c
     where c.workspace_id = p_workspace_id and c.parent_comment_id is not null
       and c.deleted_at is null and c.created_at > now() - interval '90 days'
     order by c.parent_comment_id, c.created_at desc
  ), pr as (
    select c.parent_comment_id as root_id, count(*) as n, max(c.created_at) as last_at
      from public.plan_item_comments c
     where c.workspace_id = p_workspace_id and c.parent_comment_id is not null
       and c.deleted_at is null and c.created_at > now() - interval '90 days'
     group by c.parent_comment_id
  ), pl as (
    select distinct on (c.parent_comment_id) c.parent_comment_id as root_id, c.id, c.author_user_id, left(c.body, 140) as body
      from public.plan_item_comments c
     where c.workspace_id = p_workspace_id and c.parent_comment_id is not null
       and c.deleted_at is null and c.created_at > now() - interval '90 days'
     order by c.parent_comment_id, c.created_at desc
  ), allt as (
    select 'comment'::text as kind, root.entity_type, root.entity_id, cr.root_id as root_comment_id,
           cr.n as reply_count, cr.last_at as last_reply_at, cl.id as last_reply_id,
           cl.author_user_id as last_reply_author, cl.body as last_reply_body,
           (cl.author_user_id is distinct from v_actor
            and cr.last_at > coalesce(tr.last_read_at, '-infinity'::timestamptz)) as unread
      from cr
      join cl on cl.root_id = cr.root_id
      join public.comments root on root.id = cr.root_id and root.deleted_at is null
      left join public.comment_thread_reads tr on tr.root_comment_id = cr.root_id and tr.user_id = v_actor
     where (root.author_user_id = v_actor
            or coalesce(root.mentions, '[]'::jsonb) ? v_actor::text
            or position(v_tag in lower(root.body)) > 0
            or exists (select 1 from public.comments x
                        where x.parent_comment_id = cr.root_id and x.deleted_at is null
                          and (x.author_user_id = v_actor
                               or coalesce(x.mentions, '[]'::jsonb) ? v_actor::text
                               or position(v_tag in lower(x.body)) > 0)))
       and ((root.entity_type = 'post'  and exists (select 1 from public.posts p  where p.id = root.entity_id and p.deleted_at is null))
         or (root.entity_type = 'brief' and exists (select 1 from public.briefs b where b.id = root.entity_id and b.deleted_at is null)))
    union all
    select 'plan_comment'::text, 'plan_item'::text, root.item_id, pr.root_id,
           pr.n, pr.last_at, pl.id, pl.author_user_id, pl.body,
           (pl.author_user_id is distinct from v_actor
            and pr.last_at > coalesce(tr.last_read_at, '-infinity'::timestamptz))
      from pr
      join pl on pl.root_id = pr.root_id
      join public.plan_item_comments root on root.id = pr.root_id and root.deleted_at is null
      left join public.plan_item_comment_thread_reads tr on tr.root_comment_id = pr.root_id and tr.user_id = v_actor
     where (root.author_user_id = v_actor
            or position(v_tag in lower(root.body)) > 0
            or exists (select 1 from public.plan_item_comments x
                        where x.parent_comment_id = pr.root_id and x.deleted_at is null
                          and (x.author_user_id = v_actor or position(v_tag in lower(x.body)) > 0)))
       and exists (select 1 from public.plan_items i where i.id = root.item_id and i.deleted_at is null)
  )
  select a.kind, a.entity_type, a.entity_id, a.root_comment_id, a.reply_count, a.last_reply_at,
         a.last_reply_id, a.last_reply_author, a.last_reply_body, a.unread
    from allt a
   order by a.unread desc, a.last_reply_at desc
   limit 50;
end $function$;
revoke all on function public.comment_threads_for_me_all(uuid, uuid) from public, anon;
grant execute on function public.comment_threads_for_me_all(uuid, uuid) to authenticated;
