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
pnpm --filter @srtdio/etl etl -- [--mode=dev-seed|cutover] [--dry-run] [--confirm-cutover] [--rehearse]
```

- `--mode=dev-seed` (default): PII scrubbed, wipes and reseeds this workspace's
  content so reseeds are clean.
- `--mode=cutover`: real values, never wipes, requires `--confirm-cutover`.
- `--dry-run`: logs planned per-table row counts; performs zero writes.
- `--rehearse` (cutover only): runs the full real-data load plus the checksum
  against live v1, then `ROLLBACK`s instead of committing. Zero writes are
  committed, so it does not require `--confirm-cutover`. This is the pre-cutover
  dress rehearsal.

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
- **Checksum gate (both modes):** after the load, source-planned vs loaded vs
  target-in-workspace row counts must agree per table; any mismatch aborts and
  rolls back. This also blocks a cutover into a workspace that is not empty
  (`loaded != target`).
- **v1 interceptor (cutover commit):** a real cutover refuses to `COMMIT` unless
  v1 is verified frozen for writes (database/role `default_transaction_read_only`
  is on, or v1 is a read-only standby). The harness never writes to v1 to achieve
  this; the freeze is applied out-of-band (see the runbook). A `--rehearse` run
  treats the freeze as advisory because it commits nothing.

## Cutover runbook

The v1 project ref is `ozptjplxbyswclolbxyn` (v1, LIVE PRODUCTION). Run these in
order on cutover day.

1. **Freeze v1 for writes.** On v1 (project `ozptjplxbyswclolbxyn`), so no v1
   writes are lost during the run:

   ```sql
   ALTER DATABASE postgres SET default_transaction_read_only = on;
   ```

   Existing sessions must reconnect to pick it up. The harness verifies this
   read-only default before it commits a real cutover.

2. **Ensure the target workspace is empty.** The checksum gate aborts if the
   workspace already holds content (e.g. leftover dev-seed rows), so clear it or
   target a fresh workspace first.
3. **Rehearse.** Run `--mode=cutover --rehearse`. Confirm the per-table counts
   log `OK`, note the `verify digest combined` value, and confirm
   `REHEARSAL COMPLETE` (zero writes committed).
4. **Real run.** Run `--mode=cutover --confirm-cutover`. Confirm the counts log
   `OK`, that the `verify digest combined` matches the rehearsal, and that
   `COMMIT. Migration complete.` appears.
5. **Emergency teardown (post-commit rollback).** If a committed cutover must be
   undone, delete the workspace's migrated content in FK-safe order (the same
   order `wipeWorkspaceContent` uses), then fix the issue and re-run:

   ```sql
   BEGIN;
   DELETE FROM public.asset_attachments WHERE workspace_id = '<workspace-id>';
   DELETE FROM public.assets            WHERE workspace_id = '<workspace-id>';
   DELETE FROM public.comments          WHERE workspace_id = '<workspace-id>';
   DELETE FROM public.post_versions     WHERE workspace_id = '<workspace-id>';
   DELETE FROM public.posts             WHERE workspace_id = '<workspace-id>';
   DELETE FROM public.briefs            WHERE workspace_id = '<workspace-id>';
   COMMIT;
   ```

## Out of scope

Image-file copy to R2 is cutover-only and lives in a separate later PR. The v1
image URLs are preserved in `post_versions.snapshot`.
