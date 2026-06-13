-- Already applied to live DB via MCP; committed retroactively. Do NOT re-execute manually.
--
-- Agora-sync surface for the A2b chat-agora-sync Worker. Adds the column that
-- holds the Agora group id minted when a group channel is created, the partial
-- unique index that keeps that mapping one-to-one (DM rows leave it NULL), the
-- service_role SELECT grants the Worker needs to read channels/groups/members,
-- and public.chat_channel_mark_synced: the SECURITY DEFINER proc (search_path='',
-- EXECUTE service_role only) the Worker calls to stamp last_synced_at and record
-- the returned Agora group id. chat_channels, groups and group_members already
-- exist from the baseline migration, so this file is valid on a fresh CI database
-- when it runs after the baseline.

ALTER TABLE public.chat_channels ADD COLUMN agora_group_id text;

CREATE UNIQUE INDEX chat_channels_agora_group_id_unique
  ON public.chat_channels USING btree (agora_group_id)
  WHERE (agora_group_id IS NOT NULL);

-- The Worker connects as service_role (bare client, no minted member JWT) and
-- reads these three tables to assemble the Agora group + membership state.
GRANT SELECT ON public.chat_channels TO service_role;
GRANT SELECT ON public.groups TO service_role;
GRANT SELECT ON public.group_members TO service_role;

CREATE OR REPLACE FUNCTION public.chat_channel_mark_synced(p_channel_id text, p_agora_group_id text, p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  UPDATE public.chat_channels
  SET agora_group_id = COALESCE(p_agora_group_id, agora_group_id),
      last_synced_at = now()
  WHERE channel_id = p_channel_id;
END; $function$
;

-- service_role-only EXECUTE: the Worker connects as service_role; no browser role
-- may invoke this proc.
REVOKE ALL ON FUNCTION public.chat_channel_mark_synced(text, text, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chat_channel_mark_synced(text, text, uuid) TO service_role;
