-- Induction 2/7: workspaces.client_domain (locks client invites to one email domain) and logo_url.
-- Applied to v2 (movnexawfhsyuluspxoc) via Supabase MCP on 15 Oct 2026; this file records it.
ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS client_domain text;
ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS logo_url text;

ALTER TABLE public.workspaces DROP CONSTRAINT IF EXISTS workspaces_client_domain_format;
ALTER TABLE public.workspaces ADD CONSTRAINT workspaces_client_domain_format
  CHECK (((client_domain IS NULL) OR (client_domain ~ '^[a-z0-9.-]+\.[a-z]{2,}$'::text)));

ALTER TABLE public.workspaces DROP CONSTRAINT IF EXISTS workspaces_logo_url_https;
ALTER TABLE public.workspaces ADD CONSTRAINT workspaces_logo_url_https
  CHECK (((logo_url IS NULL) OR (logo_url ~ '^https://'::text)));
