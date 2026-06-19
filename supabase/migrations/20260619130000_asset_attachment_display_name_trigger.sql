-- Already applied via MCP on the v2 project. Recorded for migration parity. Do NOT re-run.
--
-- asset_attachment_set_display_name: on INSERT of an asset_attachments row, fill
-- the parent asset's display_name from the attachment's parent-context title so
-- the Assets card shows a meaningful label instead of the raw filename:
--   post    -> the post's title
--   brief   -> the brief's title + ' (brief)'
--   comment -> the comment's owning post/brief title + ' (comment)'
-- It writes ONLY when assets.display_name is blank (NULL or whitespace), so manual
-- renames and ETL-migrated names are never overwritten. chat_message attachments
-- are skipped (no parent title). Label is clamped to 200 chars. AFTER INSERT,
-- SECURITY DEFINER, search_path = public. Replay-safe; byte-matches what is live.
CREATE OR REPLACE FUNCTION public.asset_attachment_set_display_name()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_label text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.assets a
     WHERE a.id = NEW.asset_id
       AND (a.display_name IS NULL OR btrim(a.display_name) = '')
  ) THEN
    RETURN NEW;
  END IF;

  IF NEW.entity_type = 'post' THEN
    SELECT p.title INTO v_label
      FROM public.posts p
     WHERE p.id = NEW.entity_id::uuid AND p.workspace_id = NEW.workspace_id;
  ELSIF NEW.entity_type = 'brief' THEN
    SELECT b.title || ' (brief)' INTO v_label
      FROM public.briefs b
     WHERE b.id = NEW.entity_id::uuid AND b.workspace_id = NEW.workspace_id;
  ELSIF NEW.entity_type = 'comment' THEN
    SELECT
      CASE c.entity_type
        WHEN 'post'  THEN (SELECT p.title FROM public.posts  p WHERE p.id = c.entity_id AND p.workspace_id = NEW.workspace_id)
        WHEN 'brief' THEN (SELECT b.title FROM public.briefs b WHERE b.id = c.entity_id AND b.workspace_id = NEW.workspace_id)
        ELSE NULL
      END || ' (comment)'
    INTO v_label
    FROM public.comments c
    WHERE c.id = NEW.entity_id::uuid AND c.workspace_id = NEW.workspace_id;
  ELSE
    RETURN NEW;
  END IF;

  IF v_label IS NOT NULL AND btrim(v_label) <> '' THEN
    UPDATE public.assets
       SET display_name = left(v_label, 200)
     WHERE id = NEW.asset_id
       AND (display_name IS NULL OR btrim(display_name) = '');
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS asset_attachments_set_display_name ON public.asset_attachments;
CREATE TRIGGER asset_attachments_set_display_name
AFTER INSERT ON public.asset_attachments
FOR EACH ROW EXECUTE FUNCTION public.asset_attachment_set_display_name();
