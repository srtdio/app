# @srtdio/etl

One-shot ETL that migrates Sorted v1 (Postgres, source, READ-ONLY) into Sorted v2
(Postgres, target). This is the single sanctioned place v1 is referenced. v1 is a
single-workspace, LinkedIn-only tool; v2 is multi-tenant and a superset.

- Users are **not** migrated. All migrated content is attributed to one operator
  user, in one v2 workspace owned by that operator.
- Writes go **directly to v2 tables** with full DB rights, bypassing the SECURITY
  DEFINER procs and RLS (procs need `auth.uid()`, which a script lacks). No
  `.rpc()` is ever called.
- v1 is only ever `SELECT`ed (read-only session); v2 is only ever written.

## Run

```
pnpm --filter @srtdio/etl etl -- [--mode=dev-seed|cutover] [--dry-run] [--confirm-cutover]
```

- `--mode=dev-seed` (default): PII scrubbed, wipes and reseeds this workspace's
  content so reseeds are clean.
- `--mode=cutover`: real values, never wipes, requires `--confirm-cutover`.
- `--dry-run`: logs planned per-table row counts; performs zero writes.

## Required environment

Read from `process.env`; never hardcoded. The run aborts at startup if any
required variable is missing.

| Variable                    | Purpose                                                    |
| --------------------------- | ---------------------------------------------------------- |
| `SOURCE_DATABASE_URL`       | v1 connection (used read-only).                            |
| `TARGET_DATABASE_URL`       | v2 connection.                                             |
| `EXPECTED_TARGET_REF`       | v2 project ref; the run aborts unless TARGET points at it. |
| `OPERATOR_USER_ID`          | uuid; owner + author/creator for every migrated row.       |
| `OPERATOR_EMAIL`            | ensures the operator auth user exists.                     |
| `OPERATOR_DISPLAY_NAME`     | ensures the operator profile exists.                       |
| `TARGET_WORKSPACE_NAME`     | name of the workspace to create/reuse.                     |
| `TARGET_WORKSPACE_TIMEZONE` | workspace timezone (default `Asia/Kolkata`).               |

## Safety guards (hard aborts)

- SOURCE and TARGET must not resolve to the same database.
- TARGET must match `EXPECTED_TARGET_REF`.
- Only `SELECT` runs against SOURCE; all `INSERT`/`DELETE`/`UPDATE` go to TARGET.
- `cutover` mode requires the `--confirm-cutover` launch flag.
- The whole load runs in one transaction per mode, so any failure rolls back.

## Out of scope

Image-file copy to R2 is cutover-only and lives in a separate later PR. The v1
image URLs are preserved in `post_versions.snapshot`.
