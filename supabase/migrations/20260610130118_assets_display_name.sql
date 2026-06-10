-- Already applied + verified on remote via Supabase MCP; repo history only. Do NOT re-run.
ALTER TABLE public.assets ADD COLUMN display_name text;
WITH pa AS (
  SELECT aa.asset_id, aa.entity_id::uuid AS post_id,
         row_number() OVER (PARTITION BY aa.entity_id ORDER BY aa.position NULLS LAST, aa.attached_at, aa.asset_id) AS idx,
         count(*)     OVER (PARTITION BY aa.entity_id) AS cnt
  FROM public.asset_attachments aa
  JOIN public.assets a ON a.id = aa.asset_id AND a.deleted_at IS NULL
  WHERE aa.entity_type = 'post' AND aa.deleted_at IS NULL
),
single AS (SELECT asset_id FROM pa GROUP BY asset_id HAVING count(*) = 1)
UPDATE public.assets a
SET display_name = CASE WHEN pa.cnt > 1 THEN p.title || ' ' || pa.idx ELSE p.title END
FROM pa JOIN public.posts p ON p.id = pa.post_id
WHERE a.id = pa.asset_id AND a.id IN (SELECT asset_id FROM single)
  AND a.display_name IS NULL AND coalesce(p.title,'') <> '';
