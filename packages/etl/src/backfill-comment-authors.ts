// One-time, idempotent backfill of legacy comment-author attribution for the
// cutover workspace. At cutover, loadComments() set every migrated comment's
// author_user_id to the operator, so the original v1 author's name/email were
// lost on the v2 row. v1 (read-only) still holds the real author per comment.
// This script copies that author's display name + email onto the migrated v2
// comments ONLY, into comments.legacy_author_name / legacy_author_email. It does
// NOT change author_user_id (the FK stays the operator), and it never touches v1.
//
// Posts and post_versions are intentionally OUT OF SCOPE: their blank authors
// have nothing recoverable in v1, so there is no analogous backfill for them.
//
// Run via the etl CLI subcommand (see index.ts):
//   pnpm --filter @srtdio/etl etl backfill-comment-authors --mode=dry-run|apply
// dry-run (default) reports counts and writes NOTHING. apply wraps a temp
// staging table + ONE set-based UPDATE in a single transaction; any ambiguous
// match aborts the whole transaction (rollback, non-zero exit). The
// legacy_author_name IS NULL match guard makes a second apply fill 0.

import { Pool, type PoolClient } from 'pg';
import { v7 as uuidv7 } from 'uuid';

import { sameDatabase, targetRefMatches } from './config';
import { commentBody, truncate } from './transform';

export type BackfillMode = 'dry-run' | 'apply';

// v2 legacy column limits. legacy_author_name mirrors the legacy_author_name
// limit used elsewhere in the migration (120); legacy_author_email is bounded to
// a standard address length.
export const LEGACY_NAME_MAX = 120;
export const LEGACY_EMAIL_MAX = 320;

// A page of the v1 read. Kept in the 500-1000 band like the rest of the ETL.
const PAGE_SIZE = 1000;
// Max rows per INSERT into the temp staging table (well under the bind ceiling).
const INSERT_CHUNK = 500;
// Cap on ambiguous keys logged on abort, so a pathological run cannot flood logs.
const AMBIGUOUS_LOG_LIMIT = 100;

function log(message: string): void {
  // A CLI script (not app src/**): console is the expected output sink here.
  console.log(`[etl:backfill] ${message}`);
}

// --- Pure derivations (unit-tested without a database) --------------------------

// A standard single-address email shape: a local part, an @, a domain with a dot
// and no whitespace. Deliberately strict so a free-text author like "Test
// Client" is never mistaken for an email.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The preserved author display name: the first non-empty of the resolved v1
// profile display_name then the raw author string (btrim'd), truncated to the v2
// limit. Empty/whitespace-only on both yields null (nothing recoverable).
export function legacyName(profileName: string | null, author: string | null): string | null {
  for (const candidate of [profileName, author]) {
    if (candidate === null) continue;
    const trimmed = candidate.trim();
    if (trimmed !== '') return truncate(trimmed, LEGACY_NAME_MAX);
  }
  return null;
}

// The preserved author email: the lower-cased, trimmed author when it is a
// standard email address, else null. Free-text authors (display names) yield
// null here while still keeping a name via legacyName.
export function legacyEmail(author: string | null): string | null {
  if (author === null) return null;
  const normalized = author.trim().toLowerCase();
  if (normalized === '' || !EMAIL_PATTERN.test(normalized)) return null;
  return truncate(normalized, LEGACY_EMAIL_MAX);
}

// Parse the subcommand flags. mode defaults to dry-run; only --mode=dry-run,
// --mode=apply, and the bare --dry-run/--apply aliases are accepted. Unknown
// flags abort rather than silently no-op.
export function parseBackfillMode(argv: readonly string[]): BackfillMode {
  let mode: BackfillMode = 'dry-run';
  for (const arg of argv) {
    if (arg === '--') continue;
    else if (arg === '--dry-run') mode = 'dry-run';
    else if (arg === '--apply') mode = 'apply';
    else if (arg.startsWith('--mode=')) {
      const value = arg.slice('--mode='.length);
      if (value !== 'dry-run' && value !== 'apply') {
        throw new Error(`Invalid --mode='${value}'. Expected 'dry-run' or 'apply'.`);
      }
      mode = value;
    } else {
      throw new Error(`Unknown argument '${arg}'.`);
    }
  }
  return mode;
}

// --- Config (operator-less subset of the ETL config) ---------------------------

// The backfill never writes operator/workspace rows, so it needs only the v1/v2
// connections, the target-ref pin, and the target workspace name. The names and
// safety guards are the SAME as the migration's (config.ts): same env vars, same
// same-database refusal and target-ref pinning.
export interface BackfillConfig {
  sourceUrl: string;
  targetUrl: string;
  expectedTargetRef: string;
  workspaceName: string;
}

export function loadBackfillConfig(env: Record<string, string | undefined>): BackfillConfig {
  const missing: string[] = [];
  const get = (name: string): string => {
    const raw = env[name];
    const value = raw === undefined ? '' : raw.trim();
    if (value === '') {
      missing.push(name);
      return '';
    }
    return value;
  };
  const sourceUrl = get('SOURCE_DATABASE_URL');
  const targetUrl = get('TARGET_DATABASE_URL');
  const expectedTargetRef = get('EXPECTED_TARGET_REF');
  const workspaceName = get('TARGET_WORKSPACE_NAME');
  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s): ${missing.join(', ')}.`);
  }
  return { sourceUrl, targetUrl, expectedTargetRef, workspaceName };
}

function assertSafe(config: BackfillConfig): void {
  if (sameDatabase(config.sourceUrl, config.targetUrl)) {
    throw new Error(
      'Refusing to run: SOURCE_DATABASE_URL and TARGET_DATABASE_URL resolve to the same database.',
    );
  }
  if (!targetRefMatches(config.targetUrl, config.expectedTargetRef)) {
    throw new Error(
      `Refusing to run: TARGET_DATABASE_URL does not point at EXPECTED_TARGET_REF='${config.expectedTargetRef}'.`,
    );
  }
}

// --- v1 read -------------------------------------------------------------------

interface V1CommentAuthor {
  v2_post_id: string;
  created_at: Date | string;
  message: string;
  author: string | null;
  profile_name: string | null;
}

// One paged read of every migratable (non-blank) v1 comment, joined to its v2
// post id and (left) to the author's v1 profile. Same order/filter family as the
// cutover comment load so the rows line up with what was migrated.
async function readV1Batch(read: Pool, offset: number, limit: number): Promise<V1CommentAuthor[]> {
  const result = await read.query<V1CommentAuthor>(
    `SELECT p.id::text AS v2_post_id, c.created_at, c.message, c.author,
            prof.display_name AS profile_name
       FROM public.post_comments c
       JOIN public.posts p ON c.post_id = p.post_id
       LEFT JOIN public.profiles prof ON lower(prof.email) = lower(c.author)
      WHERE c.message IS NOT NULL AND btrim(c.message) <> ''
      ORDER BY c.created_at ASC, c.id
      LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return result.rows;
}

// --- v2 reads/writes -----------------------------------------------------------

// Resolve the target workspace READ-ONLY by name (it must already exist; the
// cutover created it). Never creates it, never uses a hardcoded uuid.
async function resolveWorkspaceId(write: Pool, name: string): Promise<string> {
  const found = await write.query<{ id: string }>(
    'SELECT id FROM public.workspaces WHERE name = $1',
    [name],
  );
  if (found.rows.length === 0) {
    throw new Error(`No workspace named '${name}' exists in the target.`);
  }
  if (found.rows.length > 1) {
    throw new Error(`Expected exactly one workspace named '${name}'.`);
  }
  const id = found.rows[0]?.id;
  if (id === undefined) {
    throw new Error(`No workspace named '${name}' exists in the target.`);
  }
  return id;
}

// The set of active GBL member emails, built ONCE in a single query (no N+1).
// A v1 comment whose author email is already a live member points at that member
// (e.g. the operator), so it is skipped rather than re-attributed to a legacy
// name.
async function readMemberEmails(write: Pool, workspaceId: string): Promise<Set<string>> {
  const result = await write.query<{ email: string }>(
    `SELECT lower(u.email) AS email
       FROM auth.users u
       JOIN public.workspace_members wm ON wm.user_id = u.id
      WHERE wm.workspace_id = $1 AND wm.active = true AND u.email IS NOT NULL`,
    [workspaceId],
  );
  const set = new Set<string>();
  for (const row of result.rows) set.add(row.email);
  return set;
}

interface StagingRow {
  v2PostId: string;
  createdAt: Date | string;
  body: string;
  name: string | null;
  email: string | null;
}

async function createStaging(client: PoolClient): Promise<void> {
  await client.query(
    `CREATE TEMP TABLE _backfill_comment_authors (
       seq integer NOT NULL,
       v2_post_id uuid NOT NULL,
       created_at timestamptz NOT NULL,
       body text NOT NULL,
       legacy_author_name text,
       legacy_author_email text
     ) ON COMMIT DROP`,
  );
}

async function insertStaging(client: PoolClient, rows: readonly StagingRow[]): Promise<void> {
  const cols = 'seq, v2_post_id, created_at, body, legacy_author_name, legacy_author_email';
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const part = rows.slice(i, i + INSERT_CHUNK);
    const params: unknown[] = [];
    const tuples: string[] = [];
    let p = 1;
    part.forEach((row, j) => {
      tuples.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
      params.push(i + j, row.v2PostId, row.createdAt, row.body, row.name, row.email);
    });
    await client.query(
      `INSERT INTO _backfill_comment_authors (${cols}) VALUES ${tuples.join(', ')}`,
      params,
    );
  }
}

// The match CTE, shared by the count and the ambiguous-key reads. A v1-derived
// staging row matches a v2 comment by workspace + post + millisecond-truncated
// created_at + exact body, only where the comment is still unattributed
// (legacy_author_name IS NULL) so re-runs are idempotent. pairs is the full
// staging<->comment join; sc/cc count matches on each side so BOTH a one-to-many
// (a staging row hitting many comments) and a many-to-one (many staging rows
// hitting one comment) are detectable as ambiguous.
const MATCH_CTE = `
WITH pairs AS (
  SELECT s.seq, c.id AS comment_id
    FROM _backfill_comment_authors s
    JOIN public.comments c
      ON c.workspace_id = $1
     AND c.entity_type = 'post'
     AND c.entity_id = s.v2_post_id
     AND date_trunc('milliseconds', c.created_at) = date_trunc('milliseconds', s.created_at)
     AND c.body = s.body
     AND c.legacy_author_name IS NULL
),
sc AS (SELECT seq, count(*)::int AS n FROM pairs GROUP BY seq),
cc AS (SELECT comment_id, count(*)::int AS n FROM pairs GROUP BY comment_id)`;

interface MatchCounts {
  wouldFill: number;
  noMatch: number;
  ambiguous: number;
}

// Partition every staging row into would_fill (a clean 1:1 match), no_match (0
// candidates), or ambiguous (its row matches >1 comment, or its matched comment
// is also claimed by another staging row). The three are mutually exclusive and
// sum to the staged count.
async function classify(client: PoolClient, workspaceId: string): Promise<MatchCounts> {
  const result = await client.query<{ klass: string; n: number }>(
    `${MATCH_CTE},
classified AS (
  SELECT s.seq,
    CASE
      WHEN sc.n IS NULL THEN 'no_match'
      WHEN sc.n > 1 THEN 'ambiguous'
      WHEN EXISTS (
        SELECT 1 FROM pairs p JOIN cc ON cc.comment_id = p.comment_id
         WHERE p.seq = s.seq AND cc.n > 1
      ) THEN 'ambiguous'
      ELSE 'would_fill'
    END AS klass
    FROM _backfill_comment_authors s
    LEFT JOIN sc ON sc.seq = s.seq
)
SELECT klass, count(*)::int AS n FROM classified GROUP BY klass`,
    [workspaceId],
  );
  const counts: MatchCounts = { wouldFill: 0, noMatch: 0, ambiguous: 0 };
  for (const row of result.rows) {
    if (row.klass === 'would_fill') counts.wouldFill = Number(row.n);
    else if (row.klass === 'no_match') counts.noMatch = Number(row.n);
    else if (row.klass === 'ambiguous') counts.ambiguous = Number(row.n);
  }
  return counts;
}

interface AmbiguousKey {
  v2_post_id: string;
  created_at: Date | string;
}

async function fetchAmbiguousKeys(
  client: PoolClient,
  workspaceId: string,
): Promise<AmbiguousKey[]> {
  const result = await client.query<AmbiguousKey>(
    `${MATCH_CTE}
SELECT s.v2_post_id::text AS v2_post_id, s.created_at
  FROM _backfill_comment_authors s
  LEFT JOIN sc ON sc.seq = s.seq
 WHERE sc.n > 1
    OR EXISTS (
      SELECT 1 FROM pairs p JOIN cc ON cc.comment_id = p.comment_id
       WHERE p.seq = s.seq AND cc.n > 1
    )
 ORDER BY s.created_at
 LIMIT ${AMBIGUOUS_LOG_LIMIT}`,
    [workspaceId],
  );
  return result.rows;
}

// The single set-based UPDATE. Run only when classify() found zero ambiguous
// matches, so every joined pair is 1:1 and the result is deterministic. Returns
// the number of comments filled.
async function applyUpdate(client: PoolClient, workspaceId: string): Promise<number> {
  const result = await client.query(
    `UPDATE public.comments AS c
        SET legacy_author_name = s.legacy_author_name,
            legacy_author_email = s.legacy_author_email
       FROM _backfill_comment_authors s
      WHERE c.workspace_id = $1
        AND c.entity_type = 'post'
        AND c.entity_id = s.v2_post_id
        AND date_trunc('milliseconds', c.created_at) = date_trunc('milliseconds', s.created_at)
        AND c.body = s.body
        AND c.legacy_author_name IS NULL`,
    [workspaceId],
  );
  return result.rowCount ?? 0;
}

// --- Orchestration -------------------------------------------------------------

// Read v1 once (paged), derive + filter, stage into v2, classify, then either
// report (dry-run) or apply in one transaction. Separate read (v1, read-only)
// and write (v2) pools, both opened here and closed in finally.
export async function runBackfillCommentAuthors(argv: readonly string[]): Promise<void> {
  const mode = parseBackfillMode(argv);
  const traceId = uuidv7();
  log(`trace_id=${traceId} mode=${mode}`);

  const config = loadBackfillConfig(process.env);
  assertSafe(config);

  // Separate pools: v1 is opened read-only (any accidental write is rejected at
  // the server), v2 is the write pool.
  const read = new Pool({
    connectionString: config.sourceUrl,
    options: '-c default_transaction_read_only=on',
    max: 4,
  });
  const write = new Pool({ connectionString: config.targetUrl, max: 4 });
  try {
    const workspaceId = await resolveWorkspaceId(write, config.workspaceName);
    const members = await readMemberEmails(write, workspaceId);
    log(`target workspace ${workspaceId}; active member emails ${members.size}`);

    const staged: StagingRow[] = [];
    let scanned = 0;
    let skippedMember = 0;
    let noAuthor = 0;
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const batch = await readV1Batch(read, offset, PAGE_SIZE);
      if (batch.length === 0) break;
      for (const row of batch) {
        scanned += 1;
        const name = legacyName(row.profile_name, row.author);
        const email = legacyEmail(row.author);
        if (email !== null && members.has(email)) {
          skippedMember += 1;
          continue;
        }
        if (name === null) {
          // Blank author: nothing recoverable, like posts/post_versions.
          noAuthor += 1;
          continue;
        }
        staged.push({
          v2PostId: row.v2_post_id,
          createdAt: row.created_at,
          body: commentBody(row.message, false),
          name,
          email,
        });
      }
      if (batch.length < PAGE_SIZE) break;
    }
    log(
      `scanned ${scanned}; staged ${staged.length}; skipped-member ${skippedMember}; ` +
        `no-author ${noAuthor}`,
    );

    const client = await write.connect();
    try {
      await client.query('BEGIN');
      await createStaging(client);
      await insertStaging(client, staged);
      const counts = await classify(client, workspaceId);
      log(
        `would-fill ${counts.wouldFill}; skipped-member ${skippedMember}; ` +
          `no-match ${counts.noMatch}; ambiguous ${counts.ambiguous}`,
      );

      if (mode === 'dry-run') {
        await client.query('ROLLBACK');
        log('DRY RUN: no changes written.');
        return;
      }

      if (counts.ambiguous > 0) {
        const keys = await fetchAmbiguousKeys(client, workspaceId);
        for (const key of keys) {
          log(`ambiguous match: post=${key.v2_post_id} created_at=${String(key.created_at)}`);
        }
        await client.query('ROLLBACK');
        log(
          `APPLY aborted: ${counts.ambiguous} ambiguous match(es). ` +
            'Rolled back, nothing written.',
        );
        process.exitCode = 1;
        return;
      }

      const filled = await applyUpdate(client, workspaceId);
      await client.query('COMMIT');
      log(`APPLY committed: filled ${filled} comment(s).`);
    } catch (err) {
      await client.query('ROLLBACK');
      log('ROLLBACK. No changes were committed.');
      throw err;
    } finally {
      client.release();
    }
  } finally {
    await read.end();
    await write.end();
  }
}
