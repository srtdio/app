alter function public.workspace_search(uuid, text, uuid, integer)
  rename to workspace_search_retired_20261016;
alter function public.workspace_search_retired_20261016(uuid, text, uuid, integer)
  set schema retired;
revoke all on function retired.workspace_search_retired_20261016(uuid, text, uuid, integer)
  from public, anon, authenticated;
