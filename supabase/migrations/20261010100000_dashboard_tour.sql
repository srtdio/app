-- Prepared for v2; not applied to any database.
-- Dashboard tour: only accounts created after rollout are eligible for the tour.
-- Existing accounts are backfilled as already seen; newly created public.users
-- rows keep the null default until the user skips or completes the tour.
ALTER TABLE public.users ADD COLUMN dashboard_tour_seen_at timestamptz;

UPDATE public.users
SET dashboard_tour_seen_at = now()
WHERE dashboard_tour_seen_at IS NULL;

CREATE OR REPLACE FUNCTION public.user_dashboard_tour_state(
  p_mark_seen boolean,
  _trace_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_seen boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'invalid_payload';
  END IF;

  IF p_mark_seen THEN
    UPDATE public.users
    SET dashboard_tour_seen_at = now()
    WHERE id = v_uid
      AND dashboard_tour_seen_at IS NULL;

    IF FOUND THEN
      v_seen := true;
      PERFORM public.audit_log_write(
        p_action => 'user_dashboard_tour_seen',
        p_outcome => 'success',
        p_trace_id => _trace_id,
        p_entity_type => 'user',
        p_entity_id => v_uid::text,
        p_payload => '{}'::jsonb
      );
    ELSE
      SELECT dashboard_tour_seen_at IS NOT NULL
      INTO v_seen
      FROM public.users
      WHERE id = v_uid;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'invalid_payload';
      END IF;
    END IF;
  ELSE
    SELECT dashboard_tour_seen_at IS NOT NULL
    INTO v_seen
    FROM public.users
    WHERE id = v_uid;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'invalid_payload';
    END IF;
  END IF;

  RETURN v_seen;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.user_dashboard_tour_state(boolean, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.user_dashboard_tour_state(boolean, uuid) TO authenticated;
