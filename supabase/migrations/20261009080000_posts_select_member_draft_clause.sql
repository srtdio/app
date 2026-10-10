-- Restates live policies (applied out of band). Each is a no-op on movnexawfhsyuluspxoc:
--   posts_select_member, comments_select_member, asset_attachments_select_member.
ALTER POLICY posts_select_member ON public.posts USING ((deleted_at IS NULL)
AND EXISTS (SELECT 1 FROM public.workspace_members wm WHERE wm.workspace_id = posts.workspace_id AND wm.user_id = auth.uid() AND wm.active = true)
AND ((stage <> 'draft') OR EXISTS (SELECT 1 FROM public.workspace_members wm2 WHERE wm2.workspace_id = posts.workspace_id AND wm2.user_id = auth.uid() AND wm2.active = true AND wm2.role = ANY (ARRAY['owner','admin','agency']))));

ALTER POLICY comments_select_member ON public.comments USING ((EXISTS (SELECT 1 FROM public.workspace_members wm WHERE wm.workspace_id = comments.workspace_id AND wm.user_id = auth.uid() AND wm.active = true))
AND CASE entity_type
  WHEN 'post' THEN EXISTS (SELECT 1 FROM public.posts p WHERE p.id = comments.entity_id)
  WHEN 'brief' THEN EXISTS (SELECT 1 FROM public.briefs b WHERE b.id = comments.entity_id)
  ELSE true
END);

ALTER POLICY asset_attachments_select_member ON public.asset_attachments USING ((deleted_at IS NULL)
AND EXISTS (SELECT 1 FROM public.workspace_members wm WHERE wm.workspace_id = asset_attachments.workspace_id AND wm.user_id = auth.uid() AND wm.active = true)
AND CASE entity_type
  WHEN 'post' THEN EXISTS (SELECT 1 FROM public.posts p WHERE p.id = (asset_attachments.entity_id)::uuid)
  WHEN 'brief' THEN EXISTS (SELECT 1 FROM public.briefs b WHERE b.id = (asset_attachments.entity_id)::uuid)
  WHEN 'comment' THEN EXISTS (SELECT 1 FROM public.comments c WHERE c.id = (asset_attachments.entity_id)::uuid)
  ELSE true
END);
