// Cutover validator: a read-only proof that the v2 load matches the v1 plan and
// that every migrated image object actually exists in R2. This file is pure of
// any DB or R2 construction: every external effect arrives through the injected
// deps, so the whole report is reproduced in tests with mocked counts, a mocked
// row reader, and an in-memory object store. The runner in index.ts wires the
// real SourceDb counts, a read-only v2 COUNT/SELECT, and a presigned R2 HEAD.
//
// Nothing here writes, deletes, or mutates: it only reads and compares. ok is the
// conjunction of every check; the digest is informational (it lets a rehearsal
// run be compared byte-for-byte to the real run) and never decides pass/fail.

import { computeSha256 } from '@srtdio/storage';

// The four content tables whose row counts must match plan (v1) to target (v2).
export type TableName = 'posts' | 'briefs' | 'post_versions' | 'comments';

// One v2 asset_versions row (joined to its asset) for the workspace. kind 'link'
// rows carry an external_url and no bytes; every other kind carries R2 bytes.
export interface ImageVersionRow {
  kind: string;
  r2_key: string | null;
  sha256: string | null;
  size_bytes: number | null;
  mime_type: string | null;
  external_url: string | null;
}

export interface ValidateDeps {
  // The existing v1 read counts, reused verbatim (no new SourceDb method).
  source: {
    countPosts: () => Promise<number>;
    countRequests: () => Promise<number>;
    countPostVersionsJoined: () => Promise<number>;
    countPostsWithoutVersions: () => Promise<number>;
    countMigratableComments: () => Promise<number>;
  };
  // Read-only COUNT(*) of every loaded v2 row for the workspace (no deleted_at
  // filter: the loader migrates all source rows, one v2 row per source row).
  countTargetRows: (table: TableName) => Promise<number>;
  // v2 asset_versions joined to assets for the workspace.
  readImageVersions: () => Promise<ImageVersionRow[]>;
  // True when the object is present in the bucket.
  objectExists: (bucket: string, key: string) => Promise<boolean>;
  assetBucket: string;
}

interface ValidationCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ValidationReport {
  ok: boolean;
  checks: ValidationCheck[];
  digest: string;
}

function isLink(row: ImageVersionRow): boolean {
  return row.kind === 'link';
}

// A non-link version row is well-formed when it carries every byte-backed field
// (with a real, non-stub size) and no external_url. size_bytes === 1 is the
// dev-seed stub: it must fail in cutover, so the floor is strictly > 1.
function fileRowShapeOk(row: ImageVersionRow): boolean {
  return (
    row.r2_key !== null &&
    row.sha256 !== null &&
    row.size_bytes !== null &&
    row.size_bytes > 1 &&
    row.mime_type !== null &&
    row.external_url === null
  );
}

// A link version row is well-formed when it carries only an external_url and
// none of the byte-backed fields.
function linkRowShapeOk(row: ImageVersionRow): boolean {
  return (
    row.external_url !== null &&
    row.r2_key === null &&
    row.sha256 === null &&
    row.size_bytes === null &&
    row.mime_type === null
  );
}

export async function validateCutover(deps: ValidateDeps): Promise<ValidationReport> {
  const checks: ValidationCheck[] = [];

  // Check 1: per-table counts, plan (v1) vs target (v2). Each table is its own
  // check so a mismatch names exactly which table drifted and by how much.
  const [posts, requests, versionsJoined, postsWithoutVersions, migratableComments] =
    await Promise.all([
      deps.source.countPosts(),
      deps.source.countRequests(),
      deps.source.countPostVersionsJoined(),
      deps.source.countPostsWithoutVersions(),
      deps.source.countMigratableComments(),
    ]);

  const plan: Record<TableName, number> = {
    posts,
    briefs: requests,
    post_versions: versionsJoined + postsWithoutVersions,
    comments: migratableComments,
  };
  const tables: TableName[] = ['posts', 'briefs', 'post_versions', 'comments'];
  for (const table of tables) {
    const planned = plan[table];
    const target = await deps.countTargetRows(table);
    const delta = target - planned;
    checks.push({
      name: `count:${table}`,
      ok: delta === 0,
      detail: `plan=${planned} target=${target} delta=${delta}`,
    });
  }

  // Check 2 + 3 operate over the same v2 version rows, read once.
  const rows = await deps.readImageVersions();
  const fileRows = rows.filter((r) => !isLink(r));
  const linkRows = rows.filter(isLink);

  // Check 2: row shape. Every non-link row carries real bytes metadata; every
  // link row carries only an external_url.
  const badFile = fileRows.filter((r) => !fileRowShapeOk(r)).length;
  const badLink = linkRows.filter((r) => !linkRowShapeOk(r)).length;
  checks.push({
    name: 'asset-shape',
    ok: badFile === 0 && badLink === 0,
    detail: `file=${fileRows.length} malformed_file=${badFile} link=${linkRows.length} malformed_link=${badLink}`,
  });

  // Check 3: bytes present. Every non-link row's object must exist in the bucket.
  // A null r2_key (a malformed file row) can never be present, so it counts as
  // missing here too.
  let present = 0;
  for (const row of fileRows) {
    if (row.r2_key !== null && (await deps.objectExists(deps.assetBucket, row.r2_key))) {
      present += 1;
    }
  }
  checks.push({
    name: 'bytes-present',
    ok: present === fileRows.length,
    detail: `present=${present} total=${fileRows.length}`,
  });

  // digest: sha256 over the sorted `${r2_key}:${size_bytes}` list of non-link
  // rows. Informational only (rehearsal vs real comparison); not a pass/fail.
  const entries = fileRows
    .map((r) => `${r.r2_key}:${r.size_bytes}`)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const digest = await computeSha256(new TextEncoder().encode(entries.join('\n')));

  return { ok: checks.every((c) => c.ok), checks, digest };
}
