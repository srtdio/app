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

import { loadAssets } from './assets';
import { assertSafe, loadConfig, parseCli, type EtlConfig } from './config';
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
