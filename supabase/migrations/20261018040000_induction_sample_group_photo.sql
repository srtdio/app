-- The sample week gives the workspace's default group a display picture, as the
-- onboarding prototype (v13) showed: while the week is in the workspace, a default
-- group with no picture shows /induction-sample/gp-kr.jpg. When the week clears,
-- the picture goes again, unless someone has set their own meanwhile.
--
-- Applied to v2 (movnexawfhsyuluspxoc) via Supabase MCP at Shubham's request.

CREATE OR REPLACE FUNCTION public._induction_sample_group_photo()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.cleared_at IS NULL THEN
    UPDATE public.groups SET avatar_url = '/induction-sample/gp-kr.jpg'
     WHERE workspace_id = NEW.workspace_id AND is_default AND deleted_at IS NULL
       AND avatar_url IS NULL;
  ELSIF TG_OP = 'UPDATE' AND NEW.cleared_at IS NOT NULL AND OLD.cleared_at IS NULL THEN
    UPDATE public.groups SET avatar_url = NULL
     WHERE workspace_id = NEW.workspace_id AND is_default
       AND avatar_url = '/induction-sample/gp-kr.jpg';
  END IF;
  RETURN NULL;
END; $function$;
REVOKE EXECUTE ON FUNCTION public._induction_sample_group_photo() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS induction_sample_group_photo ON public.induction_sample_seeds;
CREATE TRIGGER induction_sample_group_photo
  AFTER INSERT OR UPDATE OF cleared_at ON public.induction_sample_seeds
  FOR EACH ROW EXECUTE FUNCTION public._induction_sample_group_photo();
