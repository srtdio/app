# Sorted v2 Schema Dump

**Project:** `movnexawfhsyuluspxoc` (Supabase Pro, Mumbai, Postgres 17)
**Generated:** 17 May 2026
**Scope:** Live state of the `public` schema. Authoritative.

This document is the single source of truth for column names, types, constraints, indexes, RLS policies, triggers, and functions. When PRD or code says one thing and this document says another, **this document wins** until the next regeneration.

To regenerate: run the same `information_schema` and `pg_catalog` queries used to build this dump.

-----

## Table of contents

1. [Tables (40)](#tables)
1. [Constraints](#constraints)
1. [Indexes](#indexes)
1. [Row-Level Security (RLS) policies](#rls-policies)
1. [Triggers](#triggers)
1. [Functions](#functions)
1. [Partitioned tables](#partitioned-tables)
1. [Locked invariants](#locked-invariants)

-----

## Tables

40 base tables in `public`. Monthly partitions (`audit_log_2026_05`, etc.) inherit from their parent; columns identical.

### `approvals`

Per-post approval ledger. One row per request. Status tracks the lifecycle.

|Column          |Type       |Nullable|Default    |
|----------------|-----------|--------|-----------|
|id              |uuid       |NOT NULL|`uuidv7()` |
|post_id         |uuid       |NOT NULL|           |
|post_version_id |uuid       |NOT NULL|           |
|workspace_id    |uuid       |NOT NULL|           |
|requested_at    |timestamptz|NOT NULL|`now()`    |
|requested_by    |uuid       |NOT NULL|           |
|status          |text       |NOT NULL|`'pending'`|
|acted_by        |uuid       |NULL    |           |
|acted_at        |timestamptz|NULL    |           |
|rejection_reason|text       |NULL    |           |
|revoked_at      |timestamptz|NULL    |           |

### `asset_attachments`

Binds an entity (post, comment, chat_message, brief) to a specific `asset_version_id`. Immutable after insert.

|Column          |Type       |Nullable|Default   |
|----------------|-----------|--------|----------|
|id              |uuid       |NOT NULL|`uuidv7()`|
|asset_id        |uuid       |NOT NULL|          |
|asset_version_id|uuid       |NOT NULL|          |
|entity_type     |text       |NOT NULL|          |
|entity_id       |text       |NOT NULL|          |
|workspace_id    |uuid       |NOT NULL|          |
|position        |integer    |NOT NULL|`0`       |
|attached_by     |uuid       |NOT NULL|          |
|attached_at     |timestamptz|NOT NULL|`now()`   |
|deleted_at      |timestamptz|NULL    |          |

### `asset_versions`

Immutable version chain. Each upload edit creates a new row.

|Column        |Type       |Nullable|Default   |
|--------------|-----------|--------|----------|
|id            |uuid       |NOT NULL|`uuidv7()`|
|asset_id      |uuid       |NOT NULL|          |
|workspace_id  |uuid       |NOT NULL|          |
|version_number|integer    |NOT NULL|          |
|r2_key        |text       |NOT NULL|          |
|mime_type     |text       |NOT NULL|          |
|sha256        |text       |NOT NULL|          |
|size_bytes    |bigint     |NOT NULL|          |
|width         |integer    |NULL    |          |
|height        |integer    |NULL    |          |
|duration_ms   |integer    |NULL    |          |
|uploaded_by   |uuid       |NOT NULL|          |
|uploaded_at   |timestamptz|NOT NULL|`now()`   |

### `assets`

Pointer row. Points to current_version_id. Soft-deletable.

|Column            |Type       |Nullable|Default   |
|------------------|-----------|--------|----------|
|id                |uuid       |NOT NULL|`uuidv7()`|
|workspace_id      |uuid       |NOT NULL|          |
|filename          |text       |NOT NULL|          |
|current_version_id|uuid       |NULL    |          |
|folder_path       |text       |NOT NULL|`'/'`     |
|tags              |text[]     |NOT NULL|`'{}'`    |
|uploaded_by       |uuid       |NOT NULL|          |
|uploaded_at       |timestamptz|NOT NULL|`now()`   |
|deleted_at        |timestamptz|NULL    |          |

### `audit_log`

Partitioned by month on `created_at`. 90-day retention. Indexed on `trace_id`.

|Column                  |Type       |Nullable|Default   |
|------------------------|-----------|--------|----------|
|id                      |uuid       |NOT NULL|`uuidv7()`|
|workspace_id            |uuid       |NULL    |          |
|actor_user_id           |uuid       |NULL    |          |
|on_behalf_of            |uuid       |NULL    |          |
|impersonation_session_id|uuid       |NULL    |          |
|action                  |text       |NOT NULL|          |
|entity_type             |text       |NULL    |          |
|entity_id               |text       |NULL    |          |
|payload                 |jsonb      |NULL    |          |
|outcome                 |text       |NOT NULL|          |
|error_code              |text       |NULL    |          |
|trace_id                |uuid       |NOT NULL|          |
|ip_subnet               |inet       |NULL    |          |
|created_at              |timestamptz|NOT NULL|`now()`   |

### `briefs`

Client-only creation. Open or Closed. Immutable content after insert.

|Column            |Type       |Nullable|Default   |
|------------------|-----------|--------|----------|
|id                |uuid       |NOT NULL|`uuidv7()`|
|workspace_id      |uuid       |NOT NULL|          |
|title             |text       |NOT NULL|          |
|objective         |text       |NOT NULL|          |
|format_requested  |text       |NULL    |          |
|brand_requirements|text       |NULL    |          |
|target_date       |date       |NULL    |          |
|reference_links   |jsonb      |NULL    |          |
|status            |text       |NOT NULL|`'open'`  |
|closed_at         |timestamptz|NULL    |          |
|closed_by         |uuid       |NULL    |          |
|created_by        |uuid       |NOT NULL|          |
|created_via       |text       |NOT NULL|`'app'`   |
|row_version       |bigint     |NOT NULL|`1`       |
|created_at        |timestamptz|NOT NULL|`now()`   |
|updated_at        |timestamptz|NOT NULL|`now()`   |
|deleted_at        |timestamptz|NULL    |          |

### `chat_channels`

Local registry of Agora channels. Source of truth for channel-id convention, ACL, and sync cursor.

|Column        |Type       |Nullable     |Default|
|--------------|-----------|-------------|-------|
|channel_id    |text       |NOT NULL (PK)|       |
|workspace_id  |uuid       |NOT NULL     |       |
|channel_type  |text       |NOT NULL     |       |
|entity_id     |uuid       |NULL         |       |
|dm_user_a     |uuid       |NULL         |       |
|dm_user_b     |uuid       |NULL         |       |
|last_synced_at|timestamptz|NULL         |       |
|created_at    |timestamptz|NOT NULL     |`now()`|

### `chat_messages`

Mirror of Agora messages. Partitioned monthly. Never on read path. Compliance + email digest only.

|Column              |Type       |Nullable|Default|
|--------------------|-----------|--------|-------|
|id                  |text       |NOT NULL|       |
|channel_id          |text       |NOT NULL|       |
|workspace_id        |uuid       |NOT NULL|       |
|sender_user_id      |uuid       |NULL    |       |
|body                |text       |NULL    |       |
|mentions            |jsonb      |NULL    |       |
|attachment_asset_ids|uuid[]     |NULL    |       |
|agora_event_id      |text       |NOT NULL|       |
|created_at          |timestamptz|NOT NULL|       |
|edited_at           |timestamptz|NULL    |       |
|deleted_at          |timestamptz|NULL    |       |

### `cockpit_access_log`

Every cockpit route hit. Operator-only visibility.

|Column          |Type       |Nullable|Default   |
|----------------|-----------|--------|----------|
|id              |uuid       |NOT NULL|`uuidv7()`|
|operator_user_id|uuid       |NOT NULL|          |
|route           |text       |NOT NULL|          |
|workspace_id    |uuid       |NULL    |          |
|session_id      |uuid       |NOT NULL|          |
|accessed_at     |timestamptz|NOT NULL|`now()`   |
|trace_id        |uuid       |NOT NULL|          |

### `cockpit_procedure_allowlist`

Whitelist of SECURITY DEFINER procs the operator can invoke. Tiered by risk.

|Column        |Type       |Nullable     |Default|
|--------------|-----------|-------------|-------|
|procedure_name|text       |NOT NULL (PK)|       |
|description   |text       |NOT NULL     |       |
|risk_tier     |text       |NOT NULL     |       |
|added_at      |timestamptz|NOT NULL     |`now()`|
|added_by      |uuid       |NOT NULL     |       |

### `comment_reactions`

Emoji reactions on comments. PK is composite.

|Column      |Type       |Nullable|Default|
|------------|-----------|--------|-------|
|comment_id  |uuid       |NOT NULL|       |
|user_id     |uuid       |NOT NULL|       |
|emoji       |text       |NOT NULL|       |
|workspace_id|uuid       |NOT NULL|       |
|created_at  |timestamptz|NOT NULL|`now()`|

### `comments`

Postgres-backed discussion. Entity-anchored (post, brief, plan_cell). Realtime-replayable.

|Column              |Type       |Nullable|Default   |
|--------------------|-----------|--------|----------|
|id                  |uuid       |NOT NULL|`uuidv7()`|
|workspace_id        |uuid       |NOT NULL|          |
|entity_type         |text       |NOT NULL|          |
|entity_id           |uuid       |NOT NULL|          |
|parent_comment_id   |uuid       |NULL    |          |
|author_user_id      |uuid       |NOT NULL|          |
|body                |text       |NOT NULL|          |
|mentions            |jsonb      |NULL    |          |
|attachment_asset_ids|uuid[]     |NULL    |          |
|is_decision         |boolean    |NOT NULL|`false`   |
|edited_at           |timestamptz|NULL    |          |
|created_at          |timestamptz|NOT NULL|`now()`   |
|deleted_at          |timestamptz|NULL    |          |

### `delivery_attempts`

Every send (email, push). For provider dedupe via `provider_message_id`.

|Column             |Type       |Nullable|Default   |
|-------------------|-----------|--------|----------|
|id                 |uuid       |NOT NULL|`uuidv7()`|
|workspace_id       |uuid       |NULL    |          |
|user_id            |uuid       |NULL    |          |
|channel            |text       |NOT NULL|          |
|template_key       |text       |NOT NULL|          |
|provider           |text       |NOT NULL|          |
|provider_message_id|text       |NULL    |          |
|status             |text       |NOT NULL|`'queued'`|
|error              |text       |NULL    |          |
|sent_at            |timestamptz|NULL    |          |
|delivered_at       |timestamptz|NULL    |          |
|bounced_at         |timestamptz|NULL    |          |
|created_at         |timestamptz|NOT NULL|`now()`   |
|email_thread_id    |uuid       |NULL    |          |

### `email_threads`

RFC-822 Message-ID anchor per work unit. One per `(workspace_id, root_type, root_id)`.

|Column      |Type       |Nullable|Default   |
|------------|-----------|--------|----------|
|id          |uuid       |NOT NULL|`uuidv7()`|
|workspace_id|uuid       |NOT NULL|          |
|root_type   |text       |NOT NULL|          |
|root_id     |uuid       |NOT NULL|          |
|message_id  |text       |NOT NULL|          |
|subject     |text       |NOT NULL|          |
|created_at  |timestamptz|NOT NULL|`now()`   |
|last_sent_at|timestamptz|NULL    |          |

### `feature_flags`

Global (workspace_id NULL) or per-workspace. Categories: killswitch, rollout, experiment, tier_gated.

|Column            |Type       |Nullable|Default   |
|------------------|-----------|--------|----------|
|id                |uuid       |NOT NULL|`uuidv7()`|
|workspace_id      |uuid       |NULL    |          |
|flag_name         |text       |NOT NULL|          |
|category          |text       |NOT NULL|          |
|enabled           |boolean    |NOT NULL|`false`   |
|rollout_percentage|smallint   |NOT NULL|`0`       |
|tier_min          |text       |NULL    |          |
|reason            |text       |NULL    |          |
|updated_by        |uuid       |NULL    |          |
|updated_at        |timestamptz|NOT NULL|`now()`   |

### `group_members`

Sorted is source of truth. Agora ACL mirrors via REST.

|Column      |Type       |Nullable|Default|
|------------|-----------|--------|-------|
|group_id    |uuid       |NOT NULL|       |
|user_id     |uuid       |NOT NULL|       |
|workspace_id|uuid       |NOT NULL|       |
|joined_at   |timestamptz|NOT NULL|`now()`|

### `groups`

Named groups for chat addressability (`#group-name`).

|Column      |Type       |Nullable|Default   |
|------------|-----------|--------|----------|
|id          |uuid       |NOT NULL|`uuidv7()`|
|workspace_id|uuid       |NOT NULL|          |
|name        |text       |NOT NULL|          |
|created_by  |uuid       |NOT NULL|          |
|created_at  |timestamptz|NOT NULL|`now()`   |
|deleted_at  |timestamptz|NULL    |          |

### `inbox_entries`

Permanent in-app event feed. Partitioned monthly. Soft-deletable.

|Column       |Type       |Nullable|Default   |
|-------------|-----------|--------|----------|
|id           |uuid       |NOT NULL|`uuidv7()`|
|user_id      |uuid       |NOT NULL|          |
|workspace_id |uuid       |NOT NULL|          |
|event_type   |text       |NOT NULL|          |
|entity_type  |text       |NULL    |          |
|entity_id    |text       |NULL    |          |
|scope        |text       |NOT NULL|          |
|scope_key    |text       |NULL    |          |
|tier         |text       |NOT NULL|`'active'`|
|payload      |jsonb      |NOT NULL|`'{}'`    |
|read_at      |timestamptz|NULL    |          |
|snoozed_until|timestamptz|NULL    |          |
|email_sent_at|timestamptz|NULL    |          |
|created_at   |timestamptz|NOT NULL|`now()`   |
|deleted_at   |timestamptz|NULL    |          |

### `intent_ledger`

Cockpit two-phase intent tracking. 60-min expiry.

|Column          |Type       |Nullable|Default         |
|----------------|-----------|--------|----------------|
|id              |uuid       |NOT NULL|`uuidv7()`      |
|operator_user_id|uuid       |NOT NULL|                |
|action          |text       |NOT NULL|                |
|target_type     |text       |NULL    |                |
|target_id       |text       |NULL    |                |
|payload         |jsonb      |NOT NULL|                |
|status          |text       |NOT NULL|`'pending'`     |
|reason_category |text       |NULL    |                |
|reason_text     |text       |NULL    |                |
|ticket_id       |text       |NULL    |                |
|created_at      |timestamptz|NOT NULL|`now()`         |
|committed_at    |timestamptz|NULL    |                |
|expires_at      |timestamptz|NOT NULL|`now() + 1 hour`|
|trace_id        |uuid       |NOT NULL|                |

### `pending_flows`

Cockpit pending flows for out-of-band external systems. 60-min expiry.

|Column          |Type       |Nullable|Default         |
|----------------|-----------|--------|----------------|
|id              |uuid       |NOT NULL|`uuidv7()`      |
|operator_user_id|uuid       |NOT NULL|                |
|flow_type       |text       |NOT NULL|                |
|external_system |text       |NOT NULL|                |
|external_ref    |text       |NULL    |                |
|payload         |jsonb      |NOT NULL|                |
|status          |text       |NOT NULL|`'open'`        |
|created_at      |timestamptz|NOT NULL|`now()`         |
|resolved_at     |timestamptz|NULL    |                |
|expires_at      |timestamptz|NOT NULL|`now() + 1 hour`|

### `plan_cells`

Plan section TBD. Schema present but UI parked.

|Column         |Type       |Nullable|Default   |
|---------------|-----------|--------|----------|
|id             |uuid       |NOT NULL|`uuidv7()`|
|plan_period_id |uuid       |NOT NULL|          |
|workspace_id   |uuid       |NOT NULL|          |
|slot_date      |date       |NOT NULL|          |
|platform       |text       |NOT NULL|          |
|title          |text       |NOT NULL|          |
|bucket_id      |uuid       |NULL    |          |
|description    |text       |NULL    |          |
|state          |text       |NOT NULL|`'draft'` |
|spawned_post_id|uuid       |NULL    |          |
|row_version    |bigint     |NOT NULL|`1`       |
|created_by     |uuid       |NOT NULL|          |
|created_at     |timestamptz|NOT NULL|`now()`   |
|updated_at     |timestamptz|NOT NULL|`now()`   |
|deleted_at     |timestamptz|NULL    |          |

### `plan_periods`

Weekly or monthly plan periods.

|Column       |Type       |Nullable|Default     |
|-------------|-----------|--------|------------|
|id           |uuid       |NOT NULL|`uuidv7()`  |
|workspace_id |uuid       |NOT NULL|            |
|granularity  |text       |NOT NULL|            |
|period_start |date       |NOT NULL|            |
|period_end   |date       |NOT NULL|            |
|approval_mode|text       |NOT NULL|`'per_cell'`|
|created_by   |uuid       |NOT NULL|            |
|created_at   |timestamptz|NOT NULL|`now()`     |
|deleted_at   |timestamptz|NULL    |            |

### `platform_accounts`

OAuth-connected platform accounts. Envelope-encrypted tokens (DEK + KEK).

|Column                 |Type       |Nullable|Default   |
|-----------------------|-----------|--------|----------|
|id                     |uuid       |NOT NULL|`uuidv7()`|
|workspace_id           |uuid       |NOT NULL|          |
|platform               |text       |NOT NULL|          |
|account_type           |text       |NOT NULL|          |
|platform_account_id    |text       |NOT NULL|          |
|display_name           |text       |NOT NULL|          |
|encrypted_access_token |bytea      |NULL    |          |
|encrypted_refresh_token|bytea      |NULL    |          |
|encrypted_dek          |bytea      |NULL    |          |
|kek_id                 |text       |NULL    |          |
|scopes                 |text[]     |NOT NULL|`'{}'`    |
|expires_at             |timestamptz|NULL    |          |
|connected_by           |uuid       |NOT NULL|          |
|connected_at           |timestamptz|NOT NULL|`now()`   |
|last_refresh_at        |timestamptz|NULL    |          |
|last_error             |text       |NULL    |          |
|disconnected_at        |timestamptz|NULL    |          |
|disconnect_grace_until |timestamptz|NULL    |          |
|deleted_at             |timestamptz|NULL    |          |

### `platform_operators`

Sorted founders / staff with cockpit access.

|Column               |Type       |Nullable     |Default|
|---------------------|-----------|-------------|-------|
|user_id              |uuid       |NOT NULL (PK)|       |
|granted_at           |timestamptz|NOT NULL     |`now()`|
|granted_by           |uuid       |NULL         |       |
|revoked_at           |timestamptz|NULL         |       |
|passkey_credential_id|text       |NULL         |       |

### `post_annotations`

Caption span or image pin. Bound to a specific post_version. **Immutable (no deleted_at).**

|Column             |Type       |Nullable|Default   |
|-------------------|-----------|--------|----------|
|id                 |uuid       |NOT NULL|`uuidv7()`|
|post_id            |uuid       |NOT NULL|          |
|workspace_id       |uuid       |NOT NULL|          |
|post_version_id    |uuid       |NOT NULL|          |
|kind               |text       |NOT NULL|          |
|caption_start      |integer    |NULL    |          |
|caption_end        |integer    |NULL    |          |
|asset_attachment_id|uuid       |NULL    |          |
|image_x            |real       |NULL    |          |
|image_y            |real       |NULL    |          |
|comment_id         |uuid       |NOT NULL|          |
|created_at         |timestamptz|NOT NULL|`now()`   |

### `post_insights`

LinkedIn metrics per post. Cursor-based polling.

|Column         |Type       |Nullable|Default    |
|---------------|-----------|--------|-----------|
|id             |uuid       |NOT NULL|`uuidv7()` |
|post_id        |uuid       |NOT NULL|           |
|workspace_id   |uuid       |NOT NULL|           |
|fetched_at     |timestamptz|NOT NULL|`now()`    |
|likes          |integer    |NOT NULL|`0`        |
|comments_count |integer    |NOT NULL|`0`        |
|shares         |integer    |NOT NULL|`0`        |
|impressions    |integer    |NOT NULL|`0`        |
|clicks         |integer    |NOT NULL|`0`        |
|engagement_rate|real       |NULL    |           |
|raw_response   |jsonb      |NULL    |           |
|fetch_outcome  |text       |NOT NULL|`'success'`|

### `post_versions`

Snapshot per pre-publish edit. **Immutable (no deleted_at).**

|Column        |Type       |Nullable|Default   |
|--------------|-----------|--------|----------|
|id            |uuid       |NOT NULL|`uuidv7()`|
|post_id       |uuid       |NOT NULL|          |
|workspace_id  |uuid       |NOT NULL|          |
|version_number|integer    |NOT NULL|          |
|snapshot      |jsonb      |NOT NULL|          |
|created_by    |uuid       |NOT NULL|          |
|created_at    |timestamptz|NOT NULL|`now()`   |

### `posts`

Core entity. `stage` = workflow. `publish_status` = auxiliary. CHECK enforces legal pairs.

|Column                   |Type       |Nullable|Default   |
|-------------------------|-----------|--------|----------|
|id                       |uuid       |NOT NULL|`uuidv7()`|
|workspace_id             |uuid       |NOT NULL|          |
|title                    |text       |NOT NULL|          |
|caption                  |text       |NULL    |          |
|bucket_id                |uuid       |NOT NULL|          |
|owner_user_id            |uuid       |NOT NULL|          |
|platform                 |text       |NOT NULL|          |
|platform_account_id      |uuid       |NULL    |          |
|format                   |text       |NOT NULL|          |
|stage                    |text       |NOT NULL|`'draft'` |
|publish_status           |text       |NOT NULL|`'draft'` |
|published_at             |timestamptz|NULL    |          |
|platform_post_id         |text       |NULL    |          |
|platform_last_modified_at|timestamptz|NULL    |          |
|publish_error_message    |text       |NULL    |          |
|publish_attempt_count    |integer    |NOT NULL|`0`       |
|target_date              |timestamptz|NULL    |          |
|scheduled_at             |timestamptz|NULL    |          |
|origin                   |text       |NOT NULL|`'manual'`|
|brief_id                 |uuid       |NULL    |          |
|plan_cell_id             |uuid       |NULL    |          |
|row_version              |bigint     |NOT NULL|`1`       |
|created_by               |uuid       |NOT NULL|          |
|created_at               |timestamptz|NOT NULL|`now()`   |
|updated_at               |timestamptz|NOT NULL|`now()`   |
|deleted_at               |timestamptz|NULL    |          |

### `schedule_job_logs`

Every Publish Queue Worker attempt. Full audit trail.

|Column          |Type       |Nullable|Default   |
|----------------|-----------|--------|----------|
|id              |uuid       |NOT NULL|`uuidv7()`|
|post_id         |uuid       |NOT NULL|          |
|workspace_id    |uuid       |NOT NULL|          |
|attempt_number  |integer    |NOT NULL|          |
|started_at      |timestamptz|NOT NULL|`now()`   |
|finished_at     |timestamptz|NULL    |          |
|outcome         |text       |NULL    |          |
|http_status     |integer    |NULL    |          |
|response_excerpt|text       |NULL    |          |
|error_code      |text       |NULL    |          |
|trace_id        |uuid       |NOT NULL|          |

### `schedule_jobs`

Publish queue. One row per post (PK is post_id). Idempotent enqueue.

|Column          |Type       |Nullable     |Default    |
|----------------|-----------|-------------|-----------|
|post_id         |uuid       |NOT NULL (PK)|           |
|workspace_id    |uuid       |NOT NULL     |           |
|scheduled_at    |timestamptz|NOT NULL     |           |
|revision        |bigint     |NOT NULL     |`1`        |
|status          |text       |NOT NULL     |`'pending'`|
|attempts        |integer    |NOT NULL     |`0`        |
|last_attempt_at |timestamptz|NULL         |           |
|last_error      |text       |NULL         |           |
|platform_post_id|text       |NULL         |           |
|completed_at    |timestamptz|NULL         |           |
|idempotency_key |text       |NULL         |           |
|created_at      |timestamptz|NOT NULL     |`now()`    |
|updated_at      |timestamptz|NOT NULL     |`now()`    |

### `session_devices`

Device fingerprint per session. RLS gate on every auth request.

|Column          |Type       |Nullable|Default   |
|----------------|-----------|--------|----------|
|id              |uuid       |NOT NULL|`uuidv7()`|
|user_id         |uuid       |NOT NULL|          |
|fingerprint_hash|text       |NOT NULL|          |
|user_agent      |text       |NULL    |          |
|ip_subnet       |inet       |NULL    |          |
|last_seen_at    |timestamptz|NOT NULL|`now()`   |
|created_at      |timestamptz|NOT NULL|`now()`   |
|revoked_at      |timestamptz|NULL    |          |

### `share_tokens`

Canonical share token. One per post. Capability fixed to `view_card`. No expiry. Revocable.

|Column      |Type       |Nullable|Default      |
|------------|-----------|--------|-------------|
|id          |uuid       |NOT NULL|`uuidv7()`   |
|post_id     |uuid       |NOT NULL|             |
|workspace_id|uuid       |NOT NULL|             |
|token_hash  |text       |NOT NULL|             |
|capability  |text       |NOT NULL|`'view_card'`|
|issued_at   |timestamptz|NOT NULL|`now()`      |
|revoked_at  |timestamptz|NULL    |             |

### `users`

User profile (separate from `auth.users`). Auto-created by trigger on auth.users insert.

|Column      |Type       |Nullable     |Default|
|------------|-----------|-------------|-------|
|id          |uuid       |NOT NULL (PK)|       |
|display_name|text       |NOT NULL     |       |
|designation |text       |NULL         |       |
|avatar_url  |text       |NULL         |       |
|deleted_at  |timestamptz|NULL         |       |
|created_at  |timestamptz|NOT NULL     |`now()`|
|updated_at  |timestamptz|NOT NULL     |`now()`|

### `webhook_events`

Inbound webhooks (Stripe, Resend, LinkedIn). Idempotency on `(source, source_event_id)`.

|Column            |Type       |Nullable|Default   |
|------------------|-----------|--------|----------|
|id                |uuid       |NOT NULL|`uuidv7()`|
|source            |text       |NOT NULL|          |
|source_event_id   |text       |NOT NULL|          |
|event_type        |text       |NOT NULL|          |
|workspace_id      |uuid       |NULL    |          |
|signature_verified|boolean    |NOT NULL|          |
|raw_payload       |jsonb      |NOT NULL|          |
|received_at       |timestamptz|NOT NULL|`now()`   |

### `webhook_processing_attempts`

Per-attempt log for webhook handlers.

|Column          |Type       |Nullable|Default   |
|----------------|-----------|--------|----------|
|id              |uuid       |NOT NULL|`uuidv7()`|
|webhook_event_id|uuid       |NOT NULL|          |
|attempt_number  |integer    |NOT NULL|          |
|started_at      |timestamptz|NOT NULL|`now()`   |
|finished_at     |timestamptz|NULL    |          |
|outcome         |text       |NULL    |          |
|error           |text       |NULL    |          |
|trace_id        |uuid       |NOT NULL|          |

### `workspace_buckets`

Content buckets/pillars per workspace. Archivable (no hard-delete).

|Column      |Type       |Nullable|Default   |
|------------|-----------|--------|----------|
|id          |uuid       |NOT NULL|`uuidv7()`|
|workspace_id|uuid       |NOT NULL|          |
|name        |text       |NOT NULL|          |
|color_hex   |text       |NOT NULL|          |
|position    |integer    |NOT NULL|`0`       |
|archived    |boolean    |NOT NULL|`false`   |
|created_at  |timestamptz|NOT NULL|`now()`   |

### `workspace_members`

User + role per workspace. `active=false` = workspace-scoped soft-delete.

|Column      |Type       |Nullable|Default   |
|------------|-----------|--------|----------|
|id          |uuid       |NOT NULL|`uuidv7()`|
|workspace_id|uuid       |NOT NULL|          |
|user_id     |uuid       |NOT NULL|          |
|role        |text       |NOT NULL|          |
|active      |boolean    |NOT NULL|`true`    |
|invited_by  |uuid       |NULL    |          |
|invited_at  |timestamptz|NOT NULL|`now()`   |
|accepted_at |timestamptz|NULL    |          |
|removed_at  |timestamptz|NULL    |          |
|rejoined_at |timestamptz|NULL    |          |

### `workspace_onboarding`

Dashboard checklist state. One row per workspace. Owners only.

|Column               |Type       |Nullable     |Default|
|---------------------|-----------|-------------|-------|
|workspace_id         |uuid       |NOT NULL (PK)|       |
|first_post_at        |timestamptz|NULL         |       |
|first_invite_at      |timestamptz|NULL         |       |
|linkedin_connected_at|timestamptz|NULL         |       |
|first_brief_at       |timestamptz|NULL         |       |
|first_schedule_at    |timestamptz|NULL         |       |
|dismissed_at         |timestamptz|NULL         |       |
|auto_hidden_at       |timestamptz|NULL         |       |

### `workspace_role_permissions`

Capability matrix. PK is `(workspace_id, role, capability)`.

|Column      |Type       |Nullable|Default|
|------------|-----------|--------|-------|
|workspace_id|uuid       |NOT NULL|       |
|role        |text       |NOT NULL|       |
|capability  |text       |NOT NULL|       |
|allowed     |boolean    |NOT NULL|`true` |
|updated_at  |timestamptz|NOT NULL|`now()`|

### `workspace_settings`

JSONB payload of preferences. PK is `workspace_id`.

|Column      |Type       |Nullable     |Default|
|------------|-----------|-------------|-------|
|workspace_id|uuid       |NOT NULL (PK)|       |
|payload     |jsonb      |NOT NULL     |`'{}'` |
|updated_at  |timestamptz|NOT NULL     |`now()`|
|updated_by  |uuid       |NULL         |       |

### `workspaces`

Tenant root. Owner FK is ON DELETE RESTRICT.

|Column                       |Type       |Nullable|Default     |
|-----------------------------|-----------|--------|------------|
|id                           |uuid       |NOT NULL|`uuidv7()`  |
|name                         |text       |NOT NULL|            |
|owner_user_id                |uuid       |NOT NULL|            |
|plan_tier                    |text       |NOT NULL|`'solo'`    |
|timezone                     |text       |NOT NULL|            |
|week_start_day               |smallint   |NOT NULL|`1`         |
|stripe_customer_id           |text       |NULL    |            |
|stripe_subscription_id       |text       |NULL    |            |
|subscription_state           |text       |NOT NULL|`'trial'`   |
|subscription_state_expires_at|timestamptz|NULL    |            |
|trial_ends_at                |timestamptz|NULL    |            |
|activated_at                 |timestamptz|NULL    |            |
|digest_default_time          |time       |NOT NULL|`'09:00:00'`|
|target_distributions         |jsonb      |NULL    |            |
|row_version                  |bigint     |NOT NULL|`1`         |
|created_at                   |timestamptz|NOT NULL|`now()`     |
|updated_at                   |timestamptz|NOT NULL|`now()`     |
|deleted_at                   |timestamptz|NULL    |            |

-----

## Constraints

### Foreign keys (with ON DELETE policy)

**Reference `public.users(id)` (SET NULL, except where noted):**

- approvals: acted_by, requested_by
- asset_attachments: attached_by
- asset_versions: uploaded_by
- assets: uploaded_by
- briefs: created_by, closed_by
- cockpit_procedure_allowlist: added_by
- delivery_attempts: user_id
- feature_flags: updated_by
- groups: created_by
- plan_cells: created_by
- plan_periods: created_by
- platform_accounts: connected_by
- platform_operators: granted_by
- post_versions: created_by
- posts: created_by, owner_user_id
- workspace_members: invited_by
- workspace_settings: updated_by
- **workspaces: owner_user_id → ON DELETE RESTRICT** (owner cannot self-delete until transferred)

**Reference `auth.users(id)` (CASCADE):**

- chat_channels: dm_user_a, dm_user_b (NO ACTION, not CASCADE)
- chat_messages: sender_user_id (NO ACTION)
- comment_reactions: user_id
- comments: author_user_id (NO ACTION)
- cockpit_access_log: operator_user_id
- group_members: user_id
- inbox_entries: user_id
- intent_ledger: operator_user_id
- pending_flows: operator_user_id
- platform_operators: user_id
- session_devices: user_id
- audit_log: actor_user_id, on_behalf_of (NO ACTION)
- users: id (CASCADE - profile dies with auth.users)

**Workspace cascades (workspace_id → workspaces.id, ON DELETE CASCADE):**

- All tenant-scoped tables except `cockpit_access_log` (SET NULL), `delivery_attempts` (SET NULL), `feature_flags` (CASCADE), `webhook_events` (SET NULL).

### Key CHECK constraints

**`posts_stage_publish_status_check` (the matrix):**

```
draft, awaiting_approval, needs_input, parked, rejected → publish_status = 'draft'
scheduled                                              → publish_status IN ('scheduled','publishing','publish_failed','publish_failed_final')
published                                              → publish_status = 'published'
```

**`posts_scheduled_needs_target_date`:** stage=‘scheduled’ requires target_date NOT NULL.

**`post_annotations_caption_fields`:** Strict mutual exclusivity.

- `kind='caption_span'`: caption_start/end NOT NULL, caption_start < caption_end, image_x/y/asset_attachment_id all NULL.
- `kind='image_pin'`: image_x/y NOT NULL, asset_attachment_id NOT NULL, caption_start/end NULL.

**`approvals_acted_consistency`:** status in (pending, superseded, revoked) ↔ acted_at/by NULL; status in (approved, rejected) ↔ acted_at/by NOT NULL.

**`approvals_revoked_consistency`:** status=‘revoked’ ↔ revoked_at NOT NULL.

**`approvals_rejection_reason`:** status=‘rejected’ → rejection_reason NOT NULL.

**`briefs_closed_consistency`:** status=‘open’ ↔ closed_at/by NULL; status=‘closed’ ↔ NOT NULL.

**`audit_log_payload_no_secrets`:** Regex-blocks bearer tokens, AWS keys, Stripe live keys, JWTs in payload.

**`audit_log_payload_size`:** payload ≤ 64KB.

**`webhook_events_payload_size`:** raw_payload ≤ 1MB.

**`chat_channels_shape`:** dm requires `dm_user_a < dm_user_b` and no entity_id; group and plan_period require entity_id.

**Regex constraints:**

- `session_devices.fingerprint_hash`: `^[a-f0-9]{64}$` (sha-256 hex)
- `share_tokens.token_hash`: `^[a-f0-9]{64}$`
- `asset_versions.sha256`: `^[a-f0-9]{64}$`
- `chat_channels.channel_id`: `^(dm|group|plan)__[a-f0-9-]{36}__.+$`
- `email_threads.message_id`: `^<(brief|post)-[a-f0-9-]{36}@srtd\.io>$`
- `feature_flags.flag_name`: `^[a-z][a-z0-9_]{0,99}$`
- `groups.name`: `^[A-Za-z0-9 -]{1,40}$`
- `workspace_buckets.color_hex`: `^#[0-9A-Fa-f]{6}$`
- `users.avatar_url`: `^https?://`

**Enum CHECKs (text columns with value lists):**

- `posts.stage` ∈ {draft, awaiting_approval, needs_input, scheduled, published, parked, rejected}
- `posts.publish_status` ∈ {draft, scheduled, publishing, published, publish_failed, publish_failed_final}
- `posts.origin` ∈ {manual, plan, brief}
- `posts.platform`, `plan_cells.platform`, `platform_accounts.platform` ∈ {linkedin, x, instagram, facebook, threads}
- `posts.format`, `briefs.format_requested` ∈ {text, single_image, carousel, video, link}
- `workspaces.plan_tier` ∈ {solo, studio, agency, enterprise}
- `workspaces.subscription_state` ∈ {trial, active, read_only, grace, soft_pause, full_pause, soft_delete}
- `workspace_members.role`, `workspace_role_permissions.role` ∈ {owner, admin, agency, client}
- `approvals.status` ∈ {pending, approved, rejected, revoked, superseded}
- `briefs.status` ∈ {open, closed}
- `briefs.created_via` ∈ {app, email_forward}
- `plan_periods.granularity` ∈ {week, month}
- `plan_periods.approval_mode` ∈ {per_cell, period_bulk}
- `plan_cells.state` ∈ {draft, proposed, approved, rejected}
- `share_tokens.capability` = `'view_card'` (only)
- `comments.entity_type` ∈ {post, brief, plan_cell}
- `asset_attachments.entity_type` ∈ {post, comment, chat_message, brief}
- `inbox_entries.event_type` ∈ {comment, mention, stage_change, approval_request, approval_decision, decision_marked, publish_success, publish_failed, brief_created, brief_closed, asset_uploaded, asset_version_added, invite, trial_warning, billing_failure, system}
- `inbox_entries.scope` ∈ {everything, posts, briefs, plans, people, groups, clients}
- `inbox_entries.tier` ∈ {urgent, active, ambient}
- `inbox_entries.entity_type` ∈ {post, brief, plan_cell, plan_period, chat_channel, workspace}
- `chat_channels.channel_type` ∈ {dm, group, plan_period}
- `webhook_events.source` ∈ {stripe, resend, linkedin}
- `cockpit_procedure_allowlist.risk_tier` ∈ {tap, medium, nuclear}
- `delivery_attempts.channel` ∈ {email, push}
- `delivery_attempts.provider` ∈ {resend, fcm, apns, web_push}
- `delivery_attempts.status` ∈ {queued, sent, delivered, bounced, complained, failed}
- `feature_flags.category` ∈ {killswitch, rollout, experiment, tier_gated}
- `feature_flags.rollout_percentage` ∈ {0, 10, 25, 50, 100}
- `intent_ledger.status` ∈ {pending, committed, failed, expired}
- `pending_flows.status` ∈ {open, resolved, discarded, expired}
- `pending_flows.flow_type` ∈ {billing_override, sentry_inspect, cf_purge, gh_diff}
- `pending_flows.external_system` ∈ {stripe, sentry, cloudflare, github, resend}
- `audit_log.outcome` ∈ {success, failure}
- `post_insights.fetch_outcome` ∈ {success, failed, partial}

### Unique constraints

- `approvals_one_pending_per_post`: unique on (post_id) WHERE status=‘pending’
- `share_tokens_canonical_one_per_post`: unique on (post_id) WHERE revoked_at IS NULL
- `share_tokens.token_hash`: UNIQUE
- `asset_versions`: UNIQUE (asset_id, version_number); UNIQUE (r2_key)
- `post_versions`: UNIQUE (post_id, version_number)
- `email_threads.message_id`: UNIQUE; `email_threads_root_unique` on (workspace_id, root_type, root_id)
- `workspace_members_active_uq`: UNIQUE (workspace_id, user_id) WHERE active=true
- `feature_flags_unique`: UNIQUE (COALESCE(workspace_id::text, ‘GLOBAL’), flag_name)
- `webhook_events_source_unique`: UNIQUE (source, source_event_id)
- `platform_accounts_unique`: UNIQUE (workspace_id, platform, platform_account_id) WHERE deleted_at IS NULL
- `plan_periods_window_unique`: UNIQUE (workspace_id, granularity, period_start) WHERE deleted_at IS NULL
- `workspace_buckets_name_unique`: UNIQUE (workspace_id, lower(name)) WHERE archived=false
- `groups_name_unique`: UNIQUE (workspace_id, lower(name)) WHERE deleted_at IS NULL
- `chat_messages_agora_event_unique`: UNIQUE (agora_event_id, created_at)
- `schedule_jobs.idempotency_key`: UNIQUE

-----

## Indexes

### Full-text search (GIN)

- `assets_filename_fts_idx`: GIN to_tsvector(‘english’, filename) WHERE deleted_at IS NULL
- `briefs_title_fts_idx`: GIN to_tsvector(‘english’, title || ’ ’ || objective) WHERE deleted_at IS NULL
- `comments_body_fts_idx`: GIN to_tsvector(‘english’, body) WHERE deleted_at IS NULL
- `assets_tags_idx`: GIN (tags) WHERE deleted_at IS NULL

### Partial indexes (soft-delete-aware)

Every table with `deleted_at` has partial indexes WHERE deleted_at IS NULL. Pattern: workspace + sort dimension.

Key examples:

- `posts_workspace_stage_idx`: (workspace_id, stage, created_at DESC) WHERE deleted_at IS NULL
- `posts_workspace_target_date_idx`: (workspace_id, target_date) WHERE deleted_at IS NULL AND target_date IS NOT NULL
- `posts_publish_status_idx`: (workspace_id, publish_status) WHERE deleted_at IS NULL
- `posts_brief_idx`: (brief_id) WHERE brief_id IS NOT NULL AND deleted_at IS NULL
- `posts_plan_cell_idx`: (plan_cell_id) WHERE plan_cell_id IS NOT NULL AND deleted_at IS NULL
- `posts_platform_account_idx`: (platform_account_id) WHERE platform_account_id IS NOT NULL AND deleted_at IS NULL
- `briefs_workspace_status_idx`: (workspace_id, status, created_at DESC) WHERE deleted_at IS NULL
- `briefs_created_by_idx`: (workspace_id, created_by, created_at DESC) WHERE deleted_at IS NULL
- `comments_entity_idx`: (workspace_id, entity_type, entity_id, created_at DESC) WHERE deleted_at IS NULL
- `comments_decision_idx`: (workspace_id, entity_type, entity_id) WHERE is_decision=true AND deleted_at IS NULL
- `comments_author_idx`: (workspace_id, author_user_id, created_at DESC) WHERE deleted_at IS NULL
- `comments_parent_idx`: (parent_comment_id) WHERE parent_comment_id IS NOT NULL AND deleted_at IS NULL

### FK indexes

- `approvals_post_version_idx`
- `asset_attachments_asset_idx`, `asset_attachments_asset_version_idx`, `asset_attachments_entity_idx`, `asset_attachments_workspace_idx` (all WHERE deleted_at IS NULL)
- `asset_versions_asset_idx`: (asset_id, version_number DESC)
- `post_annotations_post_version_idx`, `post_annotations_comment_idx`
- `post_versions_post_idx`: (post_id, version_number DESC)

### Worker / queue

- `schedule_jobs_due_idx`: (status, scheduled_at) WHERE status=‘pending’
- `schedule_jobs_running_idx`: (last_attempt_at) WHERE status=‘running’
- `chat_channels_sync_cursor_idx`: (last_synced_at NULLS FIRST)
- `intent_ledger_pending_expiry_idx`: (expires_at) WHERE status=‘pending’
- `pending_flows_open_expiry_idx`: (expires_at) WHERE status=‘open’

### Inbox (partitioned)

- `inbox_entries_unread_idx`: (user_id, read_at, created_at DESC) WHERE deleted_at IS NULL
- `inbox_entries_user_scope_idx`: (user_id, scope, created_at DESC) WHERE deleted_at IS NULL
- `inbox_entries_snoozed_idx`: (user_id, snoozed_until) WHERE snoozed_until IS NOT NULL AND deleted_at IS NULL
- `inbox_entries_email_dedupe_idx`: (user_id, email_sent_at) WHERE email_sent_at IS NULL AND deleted_at IS NULL

### Trace ID

Indexed on `trace_id` in: `audit_log`, `cockpit_access_log`, `intent_ledger`, `schedule_job_logs`, `webhook_processing_attempts`.

-----

## RLS policies

All policies are PERMISSIVE for `authenticated` role. Pattern: `EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = {table}.workspace_id AND wm.user_id = auth.uid() AND wm.active = true)`.

|Table                      |Policy                                     |Cmd   |Predicate summary                                         |
|---------------------------|-------------------------------------------|------|----------------------------------------------------------|
|approvals                  |approvals_select_member                    |SELECT|workspace member                                          |
|asset_attachments          |asset_attachments_select_member            |SELECT|deleted_at IS NULL + workspace member                     |
|asset_versions             |asset_versions_select_member               |SELECT|workspace member                                          |
|assets                     |assets_select_member                       |SELECT|deleted_at IS NULL + workspace member                     |
|audit_log                  |audit_log_select_member                    |SELECT|workspace_id NOT NULL + workspace member                  |
|briefs                     |briefs_select_agency                       |SELECT|role IN (owner, admin, agency)                            |
|briefs                     |briefs_select_client_own                   |SELECT|role=‘client’ AND created_by=auth.uid()                   |
|chat_channels              |chat_channels_select_member                |SELECT|workspace member                                          |
|chat_messages              |chat_messages_select_member                |SELECT|deleted_at IS NULL + workspace member                     |
|cockpit_access_log         |cockpit_access_log_select_operator         |SELECT|platform_operators row with revoked_at IS NULL            |
|cockpit_procedure_allowlist|cockpit_procedure_allowlist_select_operator|SELECT|platform_operators row with revoked_at IS NULL            |
|comment_reactions          |comment_reactions_select_member            |SELECT|workspace member                                          |
|comment_reactions          |comment_reactions_insert_self              |INSERT|user_id=auth.uid() + workspace member                     |
|comment_reactions          |comment_reactions_delete_self              |DELETE|user_id=auth.uid()                                        |
|comments                   |comments_select_member                     |SELECT|workspace member                                          |
|delivery_attempts          |delivery_attempts_select_member            |SELECT|workspace_id NOT NULL + workspace member                  |
|delivery_attempts          |delivery_attempts_select_operator          |SELECT|operator                                                  |
|email_threads              |email_threads_select_member                |SELECT|workspace member                                          |
|feature_flags              |feature_flags_select_member                |SELECT|workspace_id NULL OR workspace member                     |
|feature_flags              |feature_flags_select_operator              |SELECT|operator                                                  |
|group_members              |group_members_select_member                |SELECT|workspace member                                          |
|groups                     |groups_select_member                       |SELECT|deleted_at IS NULL + workspace member                     |
|inbox_entries              |inbox_entries_select_own                   |SELECT|user_id=auth.uid() + deleted_at IS NULL + workspace member|
|intent_ledger              |intent_ledger_select_operator              |SELECT|operator                                                  |
|pending_flows              |pending_flows_select_operator              |SELECT|operator                                                  |
|plan_cells                 |plan_cells_select_member                   |SELECT|deleted_at IS NULL + workspace member                     |
|plan_periods               |plan_periods_select_member                 |SELECT|deleted_at IS NULL + workspace member                     |
|platform_accounts          |platform_accounts_select_member            |SELECT|deleted_at IS NULL + workspace member                     |
|platform_operators         |platform_operators_select_self             |SELECT|user_id=auth.uid()                                        |
|post_annotations           |post_annotations_select_member             |SELECT|workspace member                                          |
|post_insights              |post_insights_select_member                |SELECT|workspace member                                          |
|post_versions              |post_versions_select_member                |SELECT|workspace member                                          |
|posts                      |posts_select_member                        |SELECT|deleted_at IS NULL + workspace member                     |
|schedule_job_logs          |schedule_job_logs_select_member            |SELECT|workspace member                                          |
|schedule_jobs              |schedule_jobs_select_member                |SELECT|workspace member                                          |
|session_devices            |session_devices_select_own                 |SELECT|user_id=auth.uid()                                        |
|session_devices            |session_devices_update_own                 |UPDATE|user_id=auth.uid()                                        |
|share_tokens               |share_tokens_select_member                 |SELECT|workspace member                                          |
|users                      |users_select_shared_workspace              |SELECT|id=auth.uid() OR users share an active workspace          |
|users                      |users_update_self                          |UPDATE|id=auth.uid()                                             |
|webhook_events             |webhook_events_select_operator             |SELECT|operator                                                  |
|webhook_processing_attempts|webhook_processing_attempts_select_operator|SELECT|operator                                                  |
|workspace_buckets          |workspace_buckets_select_member            |SELECT|workspace member                                          |
|workspace_members          |workspace_members_select_member            |SELECT|workspace member                                          |
|workspace_onboarding       |workspace_onboarding_select_owner          |SELECT|role=‘owner’ workspace member                             |
|workspace_role_permissions |workspace_role_permissions_select_member   |SELECT|workspace member                                          |
|workspace_settings         |workspace_settings_select_member           |SELECT|workspace member                                          |
|workspaces                 |workspaces_select_member                   |SELECT|deleted_at IS NULL + workspace member                     |

**No INSERT/UPDATE/DELETE policies on sensitive tables.** Writes go through SECURITY DEFINER procs only (Bounded Writer Ownership doctrine). Exceptions: `comment_reactions` (self-insert/delete) and `session_devices`/`users` (self-update).

-----

## Triggers

|Trigger                      |Table         |Timing|Event |Function                        |
|-----------------------------|--------------|------|------|--------------------------------|
|users_create_profile_trg     |**auth.users**|AFTER |INSERT|users_create_profile_on_signup()|
|users_updated_at_trg         |users         |BEFORE|UPDATE|users_set_updated_at()          |
|workspaces_seed_role_defaults|workspaces    |AFTER |INSERT|seed_workspace_role_defaults()  |
|workspaces_seed_onboarding   |workspaces    |AFTER |INSERT|seed_workspace_onboarding()     |
|workspaces_row_version_check |workspaces    |BEFORE|UPDATE|workspaces_enforce_row_version()|
|workspaces_row_version_occ   |workspaces    |BEFORE|UPDATE|enforce_row_version_increment() |
|posts_row_version_check      |posts         |BEFORE|UPDATE|posts_enforce_row_version()     |
|briefs_row_version_check     |briefs        |BEFORE|UPDATE|briefs_enforce_row_version()    |
|plan_cells_row_version_check |plan_cells    |BEFORE|UPDATE|plan_cells_enforce_row_version()|

Plus event trigger `rls_auto_enable` (DDL-level): auto-enables RLS on any newly-created `public` table.

-----

## Functions

### `uuidv7()` → uuid

Generates UUIDv7 (time-ordered). Used as default for all PK columns.

### `workspace_id()` → uuid (SECURITY DEFINER, STABLE)

Returns the workspace_id claim from the current JWT.

### `has_capability(p_capability text)` → boolean (SECURITY DEFINER, STABLE)

Looks up `workspace_role_permissions` for the current user in `public.workspace_id()`. Returns false if no row.

### `audit_log_write(p_action, p_outcome, p_trace_id, p_workspace_id, p_entity_type, p_entity_id, p_payload, p_error_code, p_on_behalf_of, p_impersonation_session_id, p_ip_subnet)` → uuid (SECURITY DEFINER)

Inserts an audit_log row with `auth.uid()` as actor.

### `users_create_profile_on_signup()` → trigger (SECURITY DEFINER)

On auth.users INSERT, creates `public.users` row. Display name from raw_user_meta_data.full_name, then .name, falling back to email prefix.

### `users_set_updated_at()` → trigger

Sets `updated_at = now()` on update.

### `seed_workspace_role_defaults()` → trigger (SECURITY DEFINER)

On workspaces INSERT, seeds 47 rows into `workspace_role_permissions` covering owner (17 caps), admin (14), agency (12), client (8). See function body for the full default matrix.

### `seed_workspace_onboarding()` → trigger (SECURITY DEFINER)

On workspaces INSERT, creates one row in `workspace_onboarding`.

### `enforce_row_version_increment()` → trigger

Generic OCC check. Errors with serialization_failure if `new.row_version <> old.row_version + 1`.

### `workspaces_enforce_row_version()` / `posts_enforce_row_version()` / `briefs_enforce_row_version()` / `plan_cells_enforce_row_version()` → trigger

Per-table OCC check that also bumps `updated_at = now()`. Errors with SQLSTATE 40001 if increment is not exactly 1.

### `rls_auto_enable()` → event_trigger (SECURITY DEFINER)

Listens for CREATE TABLE in the `public` schema and runs `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`. Safety net: no public table can be created without RLS.

-----

## Partitioned tables

Three tables partitioned by `created_at` (monthly):

- `audit_log` → `audit_log_2026_05`, `audit_log_2026_06`, `audit_log_2026_07`
- `chat_messages` → `chat_messages_2026_05`, …
- `inbox_entries` → `inbox_entries_2026_05`, …

PK on parent: `(id, created_at)` to support partition pruning.

Cron must rotate partitions: create future month, drop past-90-days month. Cron not yet built (see handoff §4f).

-----

## Locked invariants

1. **Trace ID is an explicit RPC parameter.** Not `SET LOCAL` (pgBouncer unsafe). ESLint rule on `.rpc()` calls enforces this.
1. **All sensitive writes through SECURITY DEFINER procs.** `INSERT/UPDATE/DELETE` revoked from `authenticated` on sensitive tables. Read paths via RLS only.
1. **post.stage and publish_status never conflated.** Matrix CHECK enforces.
1. **post_versions and post_annotations are immutable.** No `deleted_at`. Edit history is permanent.
1. **Magic-link approval removed.** share_tokens are canonical-only (one per post), capability=view_card, no expiry.
1. **OCC via row_version.** posts, briefs, plan_cells, workspaces enforce `+1` increment on every update.
1. **workspaces.owner_user_id → ON DELETE RESTRICT.** Owners cannot self-delete until transfer.
1. **Workspace soft-delete = 7 days; asset soft-delete = 30 days.** Hard-delete crons not yet built.
1. **Realtime subscription discipline: default deny, explicit allowlist.** Per Supabase Realtime config (not in SQL).
1. **One workspace = one end-client = one platform.** Tier price multiplies if a workspace adds platforms.

-----

## How to use this dump

- **Looking up a column?** Section 1 (Tables).
- **Wondering if a value is allowed?** Section 2 (Constraints), enum CHECKs.
- **Designing a query?** Section 3 (Indexes); use the partial indexes by adding `WHERE deleted_at IS NULL` etc.
- **Designing access?** Section 4 (RLS) + Section 6 (functions).
- **Designing a write path?** Look for an existing SECURITY DEFINER proc. None yet for the feature procs (stage_transition, approval_act, etc.); these are PR 11.
