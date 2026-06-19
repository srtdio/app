// Cutover safety harness: the verify-only v1 interceptor, the row-count parity
// checksum, and the content-hash fingerprint. None of this writes to v1: the
// freeze is applied out-of-band (see README runbook) and this layer only reads
// the catalog to confirm it. The checksum gate runs inside the load transaction
// in index.ts, so a mismatch rolls the whole load back rather than committing a
// partial or contaminated cutover.

import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';

import { type FreezeEvidence, type SourceDb } from './source';

// --- Interceptor: verify-only v1 freeze gate -----------------------------------

export interface FreezeResult {
  frozen: boolean;
  evidence: string;
}

// A database/role GUC entry reads as `name=value`; a frozen v1 carries
// `default_transaction_read_only=on` (set via ALTER DATABASE/ROLE). Postgres
// stores the boolean as the literal given, so accept the usual truthy spellings.
const READ_ONLY_RE = /^default_transaction_read_only\s*=\s*(on|true|1|yes)$/i;

// Decide whether v1 is frozen for writes from catalog evidence alone. Pure so the
// boundaries are unit-tested without a database. A standby (in recovery) is
// read-only by definition; otherwise a persisted read-only default is the freeze.
export function interpretFreeze(evidence: FreezeEvidence): FreezeResult {
  if (evidence.inRecovery) {
    return { frozen: true, evidence: 'v1 is a read-only standby (pg_is_in_recovery)' };
  }
  const hit = evidence.configs.find((c) => READ_ONLY_RE.test(c.trim()));
  if (hit !== undefined) {
    return { frozen: true, evidence: 'database/role default_transaction_read_only is on' };
  }
  return {
    frozen: false,
    evidence: 'no read-only default at database/role scope and not a standby',
  };
}

// Read v1 (SELECT-only) and interpret the freeze. Used only to gate a real
// cutover COMMIT; never writes to v1.
export async function verifyV1Frozen(source: SourceDb): Promise<FreezeResult> {
  return interpretFreeze(await source.readFreezeEvidence());
}

// --- Checksum: row-count parity ------------------------------------------------

export interface PlanCounts {
  briefs: number;
  posts: number;
  postVersions: number;
  comments: number;
}

export interface LoadedCounts extends PlanCounts {
  assets: number;
}

export type TargetCounts = LoadedCounts;

export interface CountRow {
  table: string;
  plan: number | null;
  loaded: number;
  target: number;
  ok: boolean;
}

export interface CountComparison {
  ok: boolean;
  rows: CountRow[];
  summary: string;
}

function parityRow(table: string, plan: number, loaded: number, target: number): CountRow {
  return { table, plan, loaded, target, ok: plan === loaded && loaded === target };
}

// Compare source-planned vs loaded vs target-in-workspace counts. For the four
// content tables all three must agree: plan!=loaded means a silent drop in the
// load, loaded!=target means the target workspace was not empty (e.g. a cutover
// into a workspace that still holds dev-seed rows) or an unexpected write landed.
// Assets carry no source plan (skips/dedup/failures are expected deltas), so only
// loaded==target is required there. Pure: callers throw on `ok === false`.
export function compareCounts(input: {
  plan: PlanCounts;
  loaded: LoadedCounts;
  target: TargetCounts;
}): CountComparison {
  const { plan, loaded, target } = input;
  const rows: CountRow[] = [
    parityRow('briefs', plan.briefs, loaded.briefs, target.briefs),
    parityRow('posts', plan.posts, loaded.posts, target.posts),
    parityRow('post_versions', plan.postVersions, loaded.postVersions, target.postVersions),
    parityRow('comments', plan.comments, loaded.comments, target.comments),
    {
      table: 'assets',
      plan: null,
      loaded: loaded.assets,
      target: target.assets,
      ok: loaded.assets === target.assets,
    },
  ];
  const ok = rows.every((r) => r.ok);
  const summary = rows
    .filter((r) => !r.ok)
    .map((r) => `${r.table}(plan=${r.plan ?? '-'},loaded=${r.loaded},target=${r.target})`)
    .join('; ');
  return { ok, rows, summary };
}

// Read the committed-or-pending row count per content table for the workspace.
// Runs on the target client inside the load transaction, so it sees this run's
// not-yet-committed inserts. Table names come from a fixed literal set.
export async function readTargetCounts(
  client: PoolClient,
  workspaceId: string,
): Promise<TargetCounts> {
  const q = async (table: string): Promise<number> => {
    const r = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM public.${table} WHERE workspace_id = $1`,
      [workspaceId],
    );
    return Number(r.rows[0]?.n ?? 0);
  };
  return {
    briefs: await q('briefs'),
    posts: await q('posts'),
    postVersions: await q('post_versions'),
    comments: await q('comments'),
    assets: await q('assets'),
  };
}

// --- Fingerprint: content-hash digest ------------------------------------------

export interface DigestPart {
  table: string;
  digest: string;
}

export interface Fingerprint {
  parts: DigestPart[];
  combined: string;
}

// Fold the per-table digests into one stable hash. Pure so the combine step is
// unit-tested directly; two runs (rehearsal vs real) yield the same combined
// digest when they migrate identical content.
export function combineDigests(parts: readonly DigestPart[]): string {
  const h = createHash('md5');
  for (const p of parts) h.update(`${p.table}:${p.digest}\n`);
  return h.digest('hex');
}

// Each digest hashes the table's stable business columns in id order. An empty
// table folds to md5('') rather than null, so the digest is always defined.
const DIGEST_SQL: Record<string, string> = {
  briefs: `SELECT md5(coalesce(string_agg(
             id::text || '|' || coalesce(title, '') || '|' || coalesce(status, ''),
             '\n' ORDER BY id), '')) AS digest
           FROM public.briefs WHERE workspace_id = $1`,
  posts: `SELECT md5(coalesce(string_agg(
            id::text || '|' || coalesce(title, '') || '|' || coalesce(stage, ''),
            '\n' ORDER BY id), '')) AS digest
          FROM public.posts WHERE workspace_id = $1`,
  post_versions: `SELECT md5(coalesce(string_agg(
                    id::text || '|' || post_id::text || '|' || coalesce(version_number::text, ''),
                    '\n' ORDER BY id), '')) AS digest
                  FROM public.post_versions WHERE workspace_id = $1`,
  comments: `SELECT md5(coalesce(string_agg(
               id::text || '|' || md5(coalesce(body, '')),
               '\n' ORDER BY id), '')) AS digest
             FROM public.comments WHERE workspace_id = $1`,
  assets: `SELECT md5(coalesce(string_agg(
             id::text || '|' || coalesce(filename, ''),
             '\n' ORDER BY id), '')) AS digest
           FROM public.assets WHERE workspace_id = $1`,
};

const DIGEST_TABLES = ['briefs', 'posts', 'post_versions', 'comments', 'assets'] as const;

// Compute the per-table and combined content fingerprint for the workspace. Read
// only; reported and logged, not a source-equality gate (transform/truncation
// make source and target text differ by design).
export async function fingerprintTarget(
  client: PoolClient,
  workspaceId: string,
): Promise<Fingerprint> {
  const parts: DigestPart[] = [];
  for (const table of DIGEST_TABLES) {
    const sql = DIGEST_SQL[table];
    if (sql === undefined) continue;
    const r = await client.query<{ digest: string | null }>(sql, [workspaceId]);
    parts.push({ table, digest: r.rows[0]?.digest ?? '' });
  }
  return { parts, combined: combineDigests(parts) };
}
