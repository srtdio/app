// Pre-push gate: the checks CI runs, on the files this branch changed, on the
// exact tree (working tree, staged and untracked included) before a push.
//
//   pnpm prepush
//   PREPUSH_BASE=origin/main      the ref to diff against (default: merge base with origin/main)
//   PREPUSH_SCREENS='a|b'         run exactly these visual screens (regex on the screen name)
//   PREPUSH_SNAPSHOTS=1           also compare screenshots (local renders never match CI's
//                                 WebKit image, so by default only the layout checks run)
//   PREPUSH_E2E=all               deliberate local full run: the WebKit specs the changed
//                                 files reach (e2e-webkit.yml's split + scripts/ci/e2e-select.ts,
//                                 the whole suite for a shared file)
//
// Fast by design (target under 5 min; a slower run prints a warning). Steps,
// each timed: prettier --check, eslint, tsc (app, node, and the scripts / e2e
// configs when those changed), vitest related --run (plus the tests that read
// source as text, as ci.yml does), the design ratchet, the layout checks on the
// screens the changed files feed, then WebKit e2e on ONLY the spec files this
// branch added or edited (e2e/tests/**/*.spec.ts, at most E2E_CAP = 3). No
// edited spec: skipped, e2e runs in CI. Never the e2e-select set or the whole
// suite by default: a shared file (tailwind.config.ts, e2e fixtures, global
// CSS) selects the whole suite, ~30 min and out-of-memory kills on one box,
// which E2E WebKit already runs across 6 shards.
//
// Layout checks: the screens scripts/ci/visual-select.ts picks (the same
// selection Visual CI renders), never more than SCREEN_CAP (12) and never
// every screen. When CI runs ALL (a global file: CSS, tokens, the shell,
// layout-checks*.ts, the visual config, ...) the local run takes the screens
// whose check code changed plus one screen per area. Above the cap the first
// 12 by area run (round robin); the full set is Visual CI's. Screenshots are
// not compared locally. Exit 1 when any step fails.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A local binary (node_modules/.bin): parallel `pnpm exec` calls race on pnpm's state file. */
const bin = (name: string): string => path.join(ROOT, 'node_modules', '.bin', name);

interface StepResult {
  name: string;
  ok: boolean;
  ms: number;
  output: string;
  skipped?: string;
}

const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

const lines = (s: string): string[] => s.split('\n').filter((l) => l.trim() !== '');

function baseRef(): string {
  const env = process.env.PREPUSH_BASE;
  if (env !== undefined && env !== '') return env;
  try {
    return git('merge-base', 'origin/main', 'HEAD');
  } catch {
    return 'origin/main';
  }
}

/** Files changed vs base on the working tree, plus untracked files; deletions apart. */
function changedFiles(base: string): { files: string[]; deleted: string[] } {
  const all = lines(git('diff', '--name-only', base));
  const deleted = lines(git('diff', '--name-only', '--diff-filter=D', base));
  const untracked = lines(git('ls-files', '--others', '--exclude-standard'));
  const gone = new Set(deleted);
  const files = [...new Set([...all, ...untracked])].filter((f) => !gone.has(f)).sort();
  return { files, deleted };
}

function run(
  name: string,
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<StepResult> {
  const start = Date.now();
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: ROOT,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d: Buffer) => (output += d.toString()));
    child.stderr.on('data', (d: Buffer) => (output += d.toString()));
    child.on('close', (code) => {
      resolve({ name, ok: code === 0, ms: Date.now() - start, output });
    });
    child.on('error', (err) => {
      resolve({ name, ok: false, ms: Date.now() - start, output: String(err) });
    });
  });
}

const skip = (name: string, why: string): Promise<StepResult> =>
  Promise.resolve({ name, ok: true, ms: 0, output: '', skipped: why });

const CODE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const FULL_UNIT =
  /^(vitest\.config\.ts|(.*\/)?package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig[^/]*\.json)$/;

/** ci.yml's unit selection: all, related (+ source-reading tests) or none. */
function unitArgs(files: string[], deleted: string[]): string[] | null {
  const code = files.filter((f) => !f.startsWith('docs/') && !f.endsWith('.md'));
  if (deleted.length > 0 || code.some((f) => FULL_UNIT.test(f))) return ['run'];
  const related = code.filter((f) => !f.startsWith('e2e/'));
  if (related.length === 0) return null;
  const fs = related.some((f) => !/^(src\/server\/|workers\/|\.github\/)/.test(f));
  const extra: string[] = [];
  if (fs) {
    try {
      extra.push(
        ...lines(
          git(
            'grep',
            '-lE',
            'readFileSync|readdirSync|readFile\\(',
            '--',
            '*.test.ts',
            '*.test.tsx',
            ':!e2e/**',
          ),
        ),
      );
    } catch {
      // git grep exits 1 on no match.
    }
  }
  return ['related', '--run', '--passWithNoTests', ...new Set([...related, ...extra])];
}

// ---------------------------------------------------------------------------
// Visual screens: scripts/ci/visual-select.ts (the copy Visual CI uses); a
// local run takes at most SCREEN_CAP of them (localScreens), never ALL.

interface VisualPlan {
  names: string[];
  picked: number;
  why: string;
}

async function visualPlan(base: string, files: string[]): Promise<VisualPlan | { grep: string }> {
  const env = process.env.PREPUSH_SCREENS;
  if (env !== undefined && env !== '') return { grep: env };
  const { localScreens, readScreenDefs, SCREEN_CAP, selectForDiff } =
    await import('./ci/visual-select.ts');
  const sel = await selectForDiff(base, undefined, files);
  const { names, picked } = localScreens(sel, readScreenDefs());
  const why = [
    sel.all ? 'CI runs ALL' : `CI runs ${sel.names.length}`,
    sel.all ? 'local: the targeted screens + one per area' : '',
    picked > names.length ? `capped at ${SCREEN_CAP}, full set runs in CI` : '',
  ]
    .filter((r) => r !== '')
    .join('; ');
  return { names, picked, why: names.length === 0 ? 'no screen fed by the changed files' : why };
}

// ---------------------------------------------------------------------------

/**
 * The unit run. A file that fails under the full run's load (a 5s timeout on a
 * 4-core box) is run again alone; it passes only if it passes alone, and the
 * summary names it, so a real failure still fails.
 */
async function vitest(args: string[]): Promise<StepResult> {
  const first = await run(`vitest ${args[0]}`, bin('vitest'), args);
  if (first.ok) return first;
  const plain = first.output.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');
  const failed = [
    ...new Set([...plain.matchAll(/^\s*FAIL\s+(\S+\.test\.tsx?)/gm)].map((m) => m[1] ?? '')),
  ].filter((f) => f !== '');
  if (failed.length === 0 || /Test Files\s+.*failed/.test(plain) === false) return first;
  // Each failed file alone: a load timeout clears, a real failure stays and is
  // named on its own (one real failure no longer hides a load-only one).
  const alone = await Promise.all(
    failed.map((f) => run(`vitest ${f} (alone)`, bin('vitest'), ['run', f])),
  );
  const real = alone.filter((r) => !r.ok);
  const cleared = failed.filter((_, i) => alone[i]?.ok === true);
  return {
    name: `vitest ${args[0]} (re-ran ${failed.length} alone, ${real.length} still fail)`,
    ok: real.length === 0,
    ms: first.ms + Math.max(0, ...alone.map((r) => r.ms)),
    output: [
      cleared.length > 0 ? `passed alone (load timeouts): ${cleared.join(' ')}` : '',
      ...real.map((r) => r.output),
    ]
      .filter((s) => s !== '')
      .join('\n'),
  };
}

/** The paths e2e-webkit.yml counts as UI (its changes job); anything else runs no spec. */
const E2E_UI =
  /^(src\/|e2e\/|public\/|index\.html$|package\.json$|pnpm-lock\.yaml$|playwright\.config\.ts$|vite\.config\.ts$|tailwind\.config\.ts$|postcss\.config\.js$|tsconfig[^/]*\.json$|\.github\/workflows\/e2e-webkit\.yml$)/;

/**
 * e2e-webkit.yml's split of the changed files: Worker code, unit tests and
 * non-UI paths (scripts/, docs, tests/, supabase/, ...) run nothing; an edited
 * spec runs itself; src/ goes to the import-closure selector; any other UI
 * file runs the whole suite. e2e/visual is the layout-check stage's.
 */
export function e2eReach(files: readonly string[]): {
  own: string[];
  app: string[];
  whole: boolean;
} {
  const own: string[] = [];
  const app: string[] = [];
  let whole = false;
  for (const f of files) {
    if (!E2E_UI.test(f) || f.startsWith('src/server/') || f.startsWith('e2e/visual/')) continue;
    if (/^src\/.*\.test\.tsx?$|^src\/__tests__\//.test(f)) continue;
    if (/^e2e\/tests\/.+\.spec\.ts$/.test(f)) own.push(f);
    else if (f.startsWith('src/')) app.push(f);
    else whole = true;
  }
  return { own, app, whole };
}

/** Most edited spec files a default local run takes; the rest run in CI. */
export const E2E_CAP = 3;

export type E2ePlan =
  | { mode: 'all' }
  | { mode: 'skip'; why: string }
  | { mode: 'edited'; specs: string[]; dropped: string[] };

/**
 * The local e2e stage: PREPUSH_E2E=all keeps the CI-style selection
 * (e2eSpecs); otherwise only the spec files this branch added or edited, at
 * most E2E_CAP, and none when no spec changed.
 */
export function e2ePlan(files: readonly string[], env = process.env.PREPUSH_E2E): E2ePlan {
  if (env === 'all') return { mode: 'all' };
  const edited = files.filter((f) => /^e2e\/tests\/.+\.spec\.ts$/.test(f));
  if (edited.length === 0) return { mode: 'skip', why: 'e2e runs in CI' };
  return { mode: 'edited', specs: edited.slice(0, E2E_CAP), dropped: edited.slice(E2E_CAP) };
}

/** PREPUSH_E2E=all only. null: no e2e spec; []: the whole suite; else the selected specs. */
export async function e2eSpecs(files: string[]): Promise<string[] | null> {
  const { own, app, whole } = e2eReach(files);
  if (whole) return [];
  if (app.length === 0) return own.length > 0 ? own : null;
  const { select } = await import('./ci/e2e-select.ts');
  const sel = select(app);
  if (sel.all) return [];
  const specs = [...new Set([...sel.specs, ...own])];
  return specs.length > 0 ? specs : null;
}

const grepOf = async (names: readonly string[]): Promise<string> =>
  (await import('./ci/visual-select.ts')).screensGrep(names);

/** A run longer than this prints a warning (target: under 5 min). */
const SLOW_MS = 5 * 60_000;

function fmt(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const base = baseRef();
  const { files, deleted } = changedFiles(base);
  process.stdout.write(`prepush: ${files.length} changed files vs ${base.slice(0, 12)}\n`);
  if (files.length === 0 && deleted.length === 0) {
    process.stdout.write('prepush: nothing changed\n');
    return;
  }
  const present = files.filter((f) => existsSync(path.join(ROOT, f)));
  const lintable = present.filter((f) => CODE.test(f));
  const tscArgs: string[][] = [
    ['tsc', '-p', 'tsconfig.json', '--noEmit'],
    ['tsc', '-p', 'tsconfig.node.json', '--noEmit'],
  ];
  if (files.some((f) => f.startsWith('scripts/')))
    tscArgs.push(['tsc', '-p', 'scripts/tsconfig.json', '--noEmit']);
  if (files.some((f) => f.startsWith('e2e/')))
    tscArgs.push(['tsc', '-p', 'e2e/tsconfig.json', '--noEmit']);
  for (const domain of new Set(
    files.map((f) => /^tests\/([^/]+)\//.exec(f)?.[1]).filter(Boolean),
  )) {
    const config = `tests/${domain}/tsconfig.json`;
    if (existsSync(path.join(ROOT, config))) tscArgs.push(['tsc', '-p', config, '--noEmit']);
  }
  const unit = unitArgs(files, deleted);

  // The fast checks run side by side; vitest and the visual run go after, one at a time.
  const fast = await Promise.all([
    present.length > 0
      ? run('prettier', bin('prettier'), ['--check', '--ignore-unknown', ...present])
      : skip('prettier', 'no files'),
    lintable.length > 0
      ? run('eslint', bin('eslint'), ['--no-warn-ignored', ...lintable])
      : skip('eslint', 'no code files'),
    (async (): Promise<StepResult> => {
      const start = Date.now();
      const results = await Promise.all(
        tscArgs.map((a) => run('tsc', bin(a[0] ?? 'tsc'), a.slice(1))),
      );
      return {
        name: `tsc (${tscArgs.map((a) => a[2]).join(', ')})`,
        ok: results.every((r) => r.ok),
        ms: Date.now() - start,
        output: results.map((r) => r.output).join('\n'),
      };
    })(),
    run(
      'design ratchet',
      'node',
      ['--experimental-strip-types', '--no-warnings', 'scripts/design-ratchet.ts'],
      {
        DESIGN_RATCHET_BASE: base,
      },
    ),
  ]);

  // vitest alone: beside tsc its slower tests time out on a busy machine.
  const results: StepResult[] = [
    ...fast,
    await (unit !== null ? vitest(unit) : skip('vitest', 'no unit-relevant change')),
  ];
  // Layout checks only, on the screens the changed files feed (at most
  // SCREEN_CAP); screenshots are never compared unless PREPUSH_SNAPSHOTS=1.
  const visual = await visualPlan(base, files);
  const grep =
    'grep' in visual ? visual.grep : visual.names.length > 0 ? await grepOf(visual.names) : null;
  if (grep === null) {
    results.push(await skip('layout checks', 'why' in visual ? visual.why : ''));
  } else {
    const args = ['test', '--config', 'e2e/visual/playwright.visual.config.ts', '--reporter=line'];
    if (process.env.PREPUSH_SNAPSHOTS !== '1') args.push('--ignore-snapshots');
    args.push('-g', grep);
    process.stdout.write(
      'grep' in visual
        ? `prepush: layout checks on PREPUSH_SCREENS\n`
        : `prepush: layout checks on ${visual.names.length} of ${visual.picked} screens (${visual.why}): ${visual.names.join(' ')}\n`,
    );
    results.push(await run('layout checks', bin('playwright'), args));
  }

  // WebKit e2e: only the spec files this branch edited (E2E_CAP); the full
  // suite is E2E WebKit's. PREPUSH_E2E=all: the specs the changed files reach.
  const plan = e2ePlan(files);
  if (plan.mode === 'skip') {
    results.push(await skip('e2e webkit', plan.why));
  } else if (plan.mode === 'edited') {
    if (plan.dropped.length > 0) {
      process.stdout.write(
        `prepush: ${plan.specs.length + plan.dropped.length} specs edited, running the first ${E2E_CAP}; the rest run in CI: ${plan.dropped.join(' ')}\n`,
      );
    }
    process.stdout.write(`prepush: e2e on edited specs: ${plan.specs.join(' ')}\n`);
    results.push(
      await run('e2e webkit', bin('playwright'), ['test', '--reporter=line', ...plan.specs]),
    );
  } else {
    const e2e = await e2eSpecs(files);
    if (e2e === null) {
      results.push(await skip('e2e webkit', 'no spec reached'));
    } else {
      process.stdout.write(
        `prepush: e2e (PREPUSH_E2E=all) ${e2e.length === 0 ? 'whole suite' : `${e2e.length} specs`}\n`,
      );
      results.push(await run('e2e webkit', bin('playwright'), ['test', '--reporter=line', ...e2e]));
    }
  }

  let failed = false;
  for (const r of results) {
    if (!r.ok) {
      failed = true;
      process.stdout.write(`\n---- ${r.name} FAILED ----\n${r.output.trim()}\n`);
    }
  }
  process.stdout.write('\nprepush summary\n');
  for (const r of results) {
    const state = r.skipped !== undefined ? `skip (${r.skipped})` : r.ok ? 'ok' : 'FAIL';
    process.stdout.write(`  ${r.name.padEnd(28)} ${fmt(r.ms).padStart(8)}  ${state}\n`);
  }
  const total = Date.now() - t0;
  process.stdout.write(`  ${'total'.padEnd(28)} ${fmt(total).padStart(8)}\n`);
  if (total > SLOW_MS) {
    process.stdout.write(
      `prepush: WARNING total ${fmt(total)} is over ${SLOW_MS / 60_000} min; the target is under 5 min\n`,
    );
  }
  if (failed) process.exit(1);
}

// Run only as the script (the unit test imports the selection functions).
if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `prepush: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exit(1);
  });
}
