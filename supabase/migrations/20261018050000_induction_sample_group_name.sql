-- The sample week also names the workspace's default group as the onboarding
-- prototype (v13) did: "Kestrel and Rowe" (groups_name_check allows no "&") while the week is in the workspace. The
-- group's own name (the brand the person gave) is kept aside and comes back when
-- the week clears, unless someone renamed the group meanwhile.
--
-- Applied to v2 (movnexawfhsyuluspxoc) via Supabase MCP at Shubham's request.

CREATE TABLE IF NOT EXISTS public.induction_sample_group_names (
  workspace_id uuid PRIMARY KEY REFERENCES public.workspaces(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  original_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.induction_sample_group_names ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.induction_sample_group_names FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public._induction_sample_group_photo()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_group uuid; v_name text; v_kept record;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.cleared_at IS NULL THEN
    SELECT id, name INTO v_group, v_name FROM public.groups
     WHERE workspace_id = NEW.workspace_id AND is_default AND deleted_at IS NULL
     ORDER BY created_at LIMIT 1;
    IF v_group IS NULL THEN RETURN NULL; END IF;
    UPDATE public.groups SET avatar_url = '/induction-sample/gp-kr.jpg'
     WHERE id = v_group AND avatar_url IS NULL;
    IF v_name IS DISTINCT FROM 'Kestrel and Rowe'
       AND NOT EXISTS (SELECT 1 FROM public.groups WHERE workspace_id = NEW.workspace_id
                        AND deleted_at IS NULL AND lower(name) = 'kestrel and rowe') THEN
      INSERT INTO public.induction_sample_group_names (workspace_id, group_id, original_name)
      VALUES (NEW.workspace_id, v_group, v_name)
      ON CONFLICT (workspace_id) DO NOTHING;
      UPDATE public.groups SET name = 'Kestrel and Rowe' WHERE id = v_group;
    END IF;
  ELSIF TG_OP = 'UPDATE' AND NEW.cleared_at IS NOT NULL AND OLD.cleared_at IS NULL THEN
    UPDATE public.groups SET avatar_url = NULL
     WHERE workspace_id = NEW.workspace_id AND is_default
       AND avatar_url = '/induction-sample/gp-kr.jpg';
    SELECT * INTO v_kept FROM public.induction_sample_group_names
     WHERE workspace_id = NEW.workspace_id;
    IF FOUND THEN
      UPDATE public.groups SET name = v_kept.original_name
       WHERE id = v_kept.group_id AND name = 'Kestrel and Rowe';
    END IF;
  END IF;
  RETURN NULL;
END; $function$;
REVOKE EXECUTE ON FUNCTION public._induction_sample_group_photo() FROM PUBLIC, anon, authenticated;
