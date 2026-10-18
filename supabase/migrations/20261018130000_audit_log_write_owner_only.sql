-- Record of a schema change ALREADY APPLIED LIVE on movnexawfhsyuluspxoc (18 Oct 2026, via MCP).
-- audit_log_write was executable by any signed-in user and did no membership check, so a user
-- could write audit rows (including fake approval / on-behalf-of rows) into any workspace.
-- Every legitimate caller is a SECURITY DEFINER proc owned by postgres, so owner-only EXECUTE
-- keeps them working. Idempotent. No DROP.

revoke execute on function public.audit_log_write(text,text,uuid,uuid,text,text,jsonb,text,uuid,uuid,inet)
  from public, anon, authenticated;
