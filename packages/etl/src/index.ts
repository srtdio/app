// CLI entry point and orchestration for the v1 -> v2 ETL.
//
//   pnpm --filter @srtdio/etl etl -- [--mode=dev-seed|cutover] [--dry-run] [--confirm-cutover]
//
// Modes: dev-seed (default, PII scrubbed, wipes+reseeds workspace content) and
// cutover (real values, never wipes, requires --confirm-cutover). All writes go
// to TARGET (v2) inside a single transaction; SOURCE (v1) is read-only. --dry-run
// computes planned per-table row counts and performs zero writes.
//
// CI calls `--dry-run` with NO database env: that path runs a fixture-driven
// transform self-check and never opens a connection, so CI never touches a DB.

import { Pool } from 'pg';

import { R2StorageClient, type R2StorageEnv, type TracedFetch } from '@srtdio/storage';

import { loadAssets } from './assets';
import { assertSafe, loadConfig, parseCli, type EtlConfig } from './config';
import { validateCutover, type ImageVersionRow, type TableName } from './validate';
import {
  ensureOperator,
  ensureWorkspace,
  loadBriefs,
  loadComments,
  loadPosts,
  loadPostVersions,
  wipeWorkspaceContent,
} from './load';
import { SourceDb } from './source';
import {
  briefObjective,
  briefTitle,
  buildReferenceLinks,
  buildSnapshot,
  commentBody,
  mapBriefFormatRequested,
  mapBriefStatus,
  mapPostFormat,
  mapPostStage,
  postCaption,
  postOrigin,
  postTitle,
} from './transform';

function log(message: string): void {
  // A CLI script (not app src/**): console is the expected output sink here.
  console.log(`[etl] ${message}`);
}

async function dryRun(config: EtlConfig): Promise<void> {
  const source = new SourceDb(config.sourceUrl);
  try {
    const briefs = await source.countRequests();
    const posts = await source.countPosts();
    const versionsJoined = await source.countPostVersionsJoined();
    const postsWithoutVersions = await source.countPostsWithoutVersions();
    const comments = await source.countMigratableComments();
    log(`DRY RUN (${config.cli.mode}). Planned target rows, zero writes performed:`);
    log(`  users:             1 (operator, idempotent)`);
    log(`  workspaces:        1 (find-or-create)`);
    log(`  workspace_members: 1 (owner, find-or-create)`);
    log(`  briefs:            ${briefs}`);
    log(`  posts:             ${posts}`);
    log(`  post_versions:     ${versionsJoined + postsWithoutVersions}`);
    log(`  comments:          ${comments}`);
  } finally {
    await source.end();
  }
}

// Cutover-rehearsal wipe: clear the target workspace's content in place, with no
// SOURCE read and no R2 work. The workspace is resolved read-only by name (it
// must already exist); the destructive delete runs inside a single transaction
// via the existing wipeWorkspaceContent, mirroring migrate()'s lifecycle. The
// hard safety guards (same-database refusal, EXPECTED_TARGET_REF pinning,
// --confirm-wipe) all ran in assertSafe before we reach here.
async function wipe(config: EtlConfig): Promise<void> {
  const target = new Pool({ connectionString: config.targetUrl, max: 4 });
  try {
    const client = await target.connect();
    try {
      const found = await client.query<{ id: string }>(
        'SELECT id FROM public.workspaces WHERE name = $1',
        [config.workspaceName],
      );
      const workspaceId = found.rows[0]?.id;
      if (workspaceId === undefined) {
        throw new Error(
          `Refusing to wipe: no workspace named '${config.workspaceName}' exists in the target.`,
        );
      }
      try {
        await client.query('BEGIN');
        log(`Wipe: clearing content for workspace ${workspaceId} ('${config.workspaceName}').`);
        await wipeWorkspaceContent(client, workspaceId);
        await client.query('COMMIT');
        log('COMMIT. Wipe complete.');
      } catch (err) {
        await client.query('ROLLBACK');
        log('ROLLBACK. No changes were committed.');
        throw err;
      }
    } finally {
      client.release();
    }
  } finally {
    await target.end();
  }
}

async function migrate(config: EtlConfig): Promise<void> {
  const source = new SourceDb(config.sourceUrl);
  const target = new Pool({ connectionString: config.targetUrl, max: 4 });
  try {
    const client = await target.connect();
    try {
      await client.query('BEGIN');
      log(`Mode ${config.cli.mode}: ensuring operator and workspace.`);
      await ensureOperator(client, config);
      const { id: workspaceId, assetBucket } = await ensureWorkspace(client, config);
      if (config.cli.mode === 'dev-seed') {
        log(`Dev-seed: wiping existing content for workspace ${workspaceId}.`);
        await wipeWorkspaceContent(client, workspaceId);
      }
      const briefs = await loadBriefs(client, source, config, workspaceId);
      log(`briefs: ${briefs.count}`);
      const posts = await loadPosts(client, source, config, workspaceId, briefs.map);
      log(`posts: ${posts}`);
      const versions = await loadPostVersions(client, source, config, workspaceId);
      log(`post_versions: ${versions}`);
      const { map: commentsMap, count: commentsCount } = await loadComments(
        client,
        source,
        config,
        workspaceId,
      );
      log(`comments: ${commentsCount}`);
      const assets = await loadAssets(
        client,
        source,
        config,
        workspaceId,
        assetBucket,
        briefs.map,
        commentsMap,
      );
      log(
        `assets: files=${assets.filesMigrated} links=${assets.linksMigrated} ` +
          `deduped=${assets.deduped} skipped=${assets.skipped} failed=${assets.failed}`,
      );
      await client.query('COMMIT');
      log('COMMIT. Migration complete.');
    } catch (err) {
      await client.query('ROLLBACK');
      log('ROLLBACK. No changes were committed.');
      throw err;
    } finally {
      client.release();
    }
  } finally {
    await source.end();
    await target.end();
  }
}

// R2 credential reader for the validator's byte-presence probe. Mirrors the
// reader in assets.ts (kept module-private there); validate only needs read
// access, but the same three env vars carry it.
function readR2Env(): R2StorageEnv {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const accessKeyId = process.env.CLOUDFLARE_R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY;
  if (
    accountId === undefined ||
    accountId === '' ||
    accessKeyId === undefined ||
    accessKeyId === '' ||
    secretAccessKey === undefined ||
    secretAccessKey === ''
  ) {
    throw new Error(
      'Missing R2 credentials: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_R2_ACCESS_KEY_ID, CLOUDFLARE_R2_SECRET_ACCESS_KEY.',
    );
  }
  return {
    CLOUDFLARE_ACCOUNT_ID: accountId,
    CLOUDFLARE_R2_ACCESS_KEY_ID: accessKeyId,
    CLOUDFLARE_R2_SECRET_ACCESS_KEY: secretAccessKey,
  };
}

const tracedFetch: TracedFetch = (input, init, traceId) => {
  if (traceId === undefined) return globalThis.fetch(input, init);
  const headers = new Headers(init?.headers);
  headers.set('X-Trace-Id', traceId);
  return globalThis.fetch(input, { ...init, headers });
};

// Probe an object's existence without downloading it: mint a short-lived
// presigned GET and ask for a single byte. 200/206 means present, 404 absent.
// This is a pure read; it never writes or deletes.
async function objectExistsViaR2(
  storage: R2StorageClient,
  bucket: string,
  key: string,
): Promise<boolean> {
  const url = await storage.presignGetUrl({ bucket, key, expiresInSeconds: 60 });
  const res = await globalThis.fetch(url, { headers: { Range: 'bytes=0-0' } });
  await res.body?.cancel();
  if (res.status === 404) return false;
  return res.ok;
}

// Read-only cutover validator. Compares the v1 plan to the v2 result and proves
// every migrated image object is really in R2. No BEGIN/COMMIT, no writes, no R2
// deletes. Resolves the workspace by name (never creates it) and sets a nonzero
// exit code on any mismatch.
async function validate(config: EtlConfig): Promise<void> {
  const source = new SourceDb(config.sourceUrl);
  const target = new Pool({ connectionString: config.targetUrl, max: 4 });
  const storage = new R2StorageClient(readR2Env(), tracedFetch);
  try {
    const ws = await target.query<{ id: string; asset_bucket: string }>(
      'SELECT id, asset_bucket FROM public.workspaces WHERE name = $1',
      [config.workspaceName],
    );
    if (ws.rows.length === 0) {
      throw new Error(`workspace not present: no workspace named '${config.workspaceName}'.`);
    }
    if (ws.rows.length > 1) {
      throw new Error(`expected exactly one workspace named '${config.workspaceName}'.`);
    }
    const workspace = ws.rows[0];
    if (workspace === undefined) {
      throw new Error(`workspace not present: no workspace named '${config.workspaceName}'.`);
    }
    const { id: workspaceId, asset_bucket: assetBucket } = workspace;

    const countTargetRows = async (table: TableName): Promise<number> => {
      // table is the closed TableName union, so this interpolation is safe; the
      // count is unfiltered (no deleted_at): the loader migrates all source rows.
      const r = await target.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM public.${table} WHERE workspace_id = $1`,
        [workspaceId],
      );
      return Number(r.rows[0]?.n ?? 0);
    };

    const readImageVersions = async (): Promise<ImageVersionRow[]> => {
      const r = await target.query<{
        kind: string;
        r2_key: string | null;
        sha256: string | null;
        size_bytes: string | number | null;
        mime_type: string | null;
        external_url: string | null;
      }>(
        `SELECT av.kind, av.r2_key, av.sha256, av.size_bytes, av.mime_type, av.external_url
           FROM public.asset_versions av
           JOIN public.assets a ON a.id = av.asset_id
          WHERE av.workspace_id = $1`,
        [workspaceId],
      );
      return r.rows.map((row) => ({
        kind: row.kind,
        r2_key: row.r2_key,
        sha256: row.sha256,
        size_bytes: row.size_bytes === null ? null : Number(row.size_bytes),
        mime_type: row.mime_type,
        external_url: row.external_url,
      }));
    };

    const report = await validateCutover({
      source: {
        countPosts: () => source.countPosts(),
        countRequests: () => source.countRequests(),
        countPostVersionsJoined: () => source.countPostVersionsJoined(),
        countPostsWithoutVersions: () => source.countPostsWithoutVersions(),
        countMigratableComments: () => source.countMigratableComments(),
      },
      countTargetRows,
      readImageVersions,
      objectExists: (bucket, key) => objectExistsViaR2(storage, bucket, key),
      assetBucket,
    });

    log(`VALIDATE (${config.cli.mode}). Read-only cutover validation, zero writes:`);
    for (const check of report.checks) {
      log(`  [${check.ok ? 'PASS' : 'FAIL'}] ${check.name}: ${check.detail}`);
    }
    log(`  digest: ${report.digest}`);
    log(report.ok ? 'VALIDATION OK.' : 'VALIDATION FAILED.');
    if (!report.ok) {
      process.exitCode = 1;
    }
  } finally {
    await source.end();
    await target.end();
  }
}

// Fixture-driven transform self-check. Exercises every mapping with no database,
// proving the transform layer + CLI wiring run end to end. Used by CI's --dry-run.
function transformSelfCheck(): void {
  const stages = [
    'published',
    'scheduled',
    'ready',
    'awaiting_approval',
    'awaiting_brand_input',
    'rejected',
    'parked',
    null,
  ];
  const formats = ['Photo', 'Creative', 'Carousel', 'Text', 'Video', null];
  const contentTypes = ['CREATIVE', 'PHOTO', 'VIDEO', 'TEXT', null];

  let mapped = 0;
  for (const s of stages) {
    void mapPostStage(s, false);
    void mapPostStage(s, true);
    mapped += 2;
  }
  for (const f of formats) {
    void mapPostFormat(f);
    mapped += 1;
  }
  for (const c of contentTypes) {
    void mapBriefFormatRequested(c);
    void mapBriefStatus(c);
    mapped += 2;
  }
  const brief = {
    title: briefTitle('Launch teaser'),
    objective: briefObjective('', 'Launch teaser', true),
    refs: buildReferenceLinks('https://drive.example/x', ['https://img.example/1.jpg']),
  };
  const post = {
    title: postTitle(null),
    caption: postCaption('ping me at jane@example.com or 98765 43210', true),
    origin: postOrigin('0190a000-0000-7000-8000-000000000000'),
  };
  const snapshot = buildSnapshot(
    {
      content: 'call 98765 43210',
      caption: 'see admin@example.com',
      images: ['https://img.example/1.jpg'],
      canvaLink: null,
      driveLink: null,
      linkedinLink: null,
      contentPillar: 'awareness',
      location: 'Mumbai',
      editedBy: 'Jane Doe',
    },
    true,
  );
  const body = commentBody('reach me at sam@example.com', true);

  log('SELF-CHECK (--dry-run, no database). Transform layer exercised:');
  log(`  mappings evaluated: ${mapped}`);
  log(`  brief sample:       ${JSON.stringify(brief)}`);
  log(`  post sample:        ${JSON.stringify(post)}`);
  log(`  snapshot sample:    ${JSON.stringify(snapshot)}`);
  log(`  comment body:       ${JSON.stringify(body)}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cli = parseCli(argv);

  // CI path: --dry-run with no database configured runs the offline self-check.
  if (cli.dryRun && (!process.env.SOURCE_DATABASE_URL || !process.env.TARGET_DATABASE_URL)) {
    transformSelfCheck();
    return;
  }

  const config = loadConfig(process.env, argv);
  assertSafe(config);

  if (config.cli.wipe) {
    await wipe(config);
    return;
  }
  if (config.cli.validate) {
    await validate(config);
    return;
  }
  if (config.cli.dryRun) {
    await dryRun(config);
    return;
  }
  await migrate(config);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[etl] FATAL: ${message}`);
  process.exitCode = 1;
});
