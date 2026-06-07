# inbox-writer

Cloudflare Worker that fans Supabase Realtime changes out into `inbox_entries`.
Worker-only fan-out (no DB triggers): it subscribes to `postgres_changes` on
`posts`, `comments`, `briefs`, `assets`, `asset_versions` and `workspace_members`,
derives an event type + recipient set per change, and writes one inbox entry per
recipient through `@srtdio/inbox`.

## How it works

```
Realtime change -> mapChangePayload -> ChangeEvent
  -> buildEnvelope        (entity / scope / payload; null if not a trigger)
  -> computeRecipients    (recipient + event_type + tier, per EVENT MAP)
  -> per recipient: KV dedupe -> writeInboxEntry -> KV put (7-day TTL)
```

`writeInboxEntry` wraps the `SECURITY DEFINER` proc `public.inbox_entry_create`,
which has **no `EXECUTE` grant to `authenticated`** - server / service-role
callers only. The proc gates on `is_active_workspace_member(auth.uid())`, so the
write client is authenticated as an active workspace member via a short-lived
`service_role` JWT carrying a `sub` claim (`createActingClient`). A bare service
key has no `sub` and is rejected by design; this is verified by the grant-check
test.

## Idempotency

Each fan-out write is keyed by
`sha256(source_table | source_id | event_type | recipient_user_id)` in the
`inbox_writer_dedupe` KV namespace (binding `INBOX_DEDUPE`, 7-day TTL). A replay
of the same source row finds the key present and writes nothing.

## Observability

One uuid v7 trace id is generated per source event and propagated as the
explicit `_trace_id` param into both `inbox_entry_create` and the failure-path
`audit_log_write` (`action = inbox_writer_failure`). No failure is dropped
silently.

## Bindings / secrets

| Name                        | Kind         | Notes                                       |
| --------------------------- | ------------ | ------------------------------------------- |
| `INBOX_DEDUPE`              | KV namespace | `inbox_writer_dedupe`                       |
| `SUPABASE_URL`              | var          | project URL                                 |
| `SUPABASE_SERVICE_ROLE_KEY` | secret       | reads + audit; minted tokens' apikey        |
| `SUPABASE_JWT_SECRET`       | secret       | signs the `service_role`+`sub` acting token |
