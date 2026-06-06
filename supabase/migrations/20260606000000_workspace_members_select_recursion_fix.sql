-- Workspace_members RLS recursion fix. Schema already applied to movnexawfhsyuluspxoc. Do NOT execute.
-- Replaces the recursive workspace_members_select_member USING expression with a SECURITY DEFINER
-- membership helper that bypasses RLS, breaking the infinite recursion across membership-gated reads.

create function public.is_active_workspace_member(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = p_workspace_id
      and wm.user_id = auth.uid()
      and wm.active = true
  );
$$;

revoke all on function public.is_active_workspace_member(uuid) from public, anon;
grant execute on function public.is_active_workspace_member(uuid) to authenticated;

alter policy workspace_members_select_member
  on public.workspace_members
  using (public.is_active_workspace_member(workspace_id));
