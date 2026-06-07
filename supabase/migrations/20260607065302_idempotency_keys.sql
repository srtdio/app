-- Already applied to v2 via MCP on 2026-06-07. Do NOT execute. Service-role-only infra table: RLS enabled with no policies; service_role bypasses RLS and is the sole writer (HTTP idempotency middleware).
CREATE TABLE public.idempotency_keys (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  key             text NOT NULL,
  request_hash    text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  response_status integer CHECK (response_status IS NULL OR response_status BETWEEN 100 AND 599),
  response_body   jsonb,
  status          text NOT NULL DEFAULT 'in_flight' CHECK (status IN ('in_flight','completed')),
  workspace_id    uuid REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  trace_id        uuid NOT NULL,
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT idempotency_keys_completed_has_status
    CHECK (status <> 'completed' OR response_status IS NOT NULL)
);
CREATE UNIQUE INDEX idempotency_keys_scope_key_uq
  ON public.idempotency_keys (key, workspace_id, user_id) NULLS NOT DISTINCT;
CREATE INDEX idempotency_keys_expires_at_idx
  ON public.idempotency_keys (expires_at);
ALTER TABLE public.idempotency_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.idempotency_keys FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.idempotency_keys TO service_role;
