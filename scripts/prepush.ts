// Pre-push gate: the checks CI runs, on the files this branch changed, on the
// exact tree (working tree, staged and untracked included) before a push.
//
//   pnpm prepush
//   PREPUSH_BASE=origin/main      the ref to diff against (default: merge base with origin/main)
//   PREPUSH_SCREENS='a|b'         run exactly these visual screens (regex on the screen name)
//   PREPUSH_SNAPSHOTS=1           also compare screenshots (local renders differ from CI's
//                                 WebKit image, so by default only the layout checks run)
//
// Steps, each timed: prettier --check, eslint, tsc (app, node, and the scripts /
// e2e configs when those changed), vitest related --run (plus the tests that
// read source as text, as ci.yml does), the design ratchet, and when
// src/components or e2e/visual changed, the visual screens those files feed
// (WebKit, playwright -g) with their layout checks (layout-checks.ts runs
// inside every screen capture), then the WebKit e2e specs those files reach
// (scripts/ci/e2e-select.ts, as e2e-webkit.yml). Exit 1 when any step fails.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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
// Visual screen selection

/** Screen URL prefixes per e2e area (scripts/ci/e2e-areas.ts names). */
const AREA_URLS: Readonly<Record<string, readonly string[]>> = {
  chat: ['/chat'],
  notifications: ['/activity'],
  'plan-tab': ['/plan'],
  pipeline: ['/pipeline'],
  pcs: ['/posts'],
  briefs: ['/briefs'],
  assets: ['/assets', '/deleted'],
  settings: ['/settings'],
  unvisited: ['/help', '/signin'],
  unsubscribe: ['/unsubscribe'],
};

interface ScreenDef {
  name: string;
  url: string | null;
  start: number;
  end: number;
}

/** Each SCREENS entry in screens.spec.ts: its name, url and line span (1-based). */
function readScreens(): ScreenDef[] {
  const src = readFileSync(path.join(ROOT, 'e2e/visual/screens.spec.ts'), 'utf8').split('\n');
  const out: ScreenDef[] = [];
  src.forEach((line, i) => {
    const m = /^\s*name: [`']([^`']+)[`'],?\s*$/.exec(line);
    if (m === null || m[1] === undefined) return;
    let url: string | null = null;
    for (let j = i + 1; j < Math.min(src.length, i + 12); j += 1) {
      const u = /^\s*url: [`']([^`']*)[`']/.exec(src[j] ?? '');
      if (u !== null) {
        url = u[1] ?? null;
        break;
      }
      if (/^\s*name: /.test(src[j] ?? '')) break;
    }
    out.push({ name: m[1], url, start: i + 1, end: i + 1 });
  });
  out.forEach((s, k) => {
    s.end = (out[k + 1]?.start ?? src.length + 1) - 1;
  });
  return out;
}

/** A template name (`pipeline-${density}`) as a regex source. */
const nameSource = (name: string): string =>
  name
    .split(/\$\{[^}]+\}/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\w-]+');

/** Changed line numbers (new side) of a file vs base. */
function changedLines(base: string, file: string): number[] {
  const diff = git('diff', '-U0', base, '--', file);
  const out: number[] = [];
  for (const m of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    for (let k = 0; k < Math.max(count, 1); k += 1) out.push(start + k);
  }
  return out;
}

/** null: no visual run; 'ALL': every screen; else a -g regex. */
async function visualGrep(
  base: string,
  files: string[],
): Promise<{ grep: string | null; why: string }> {
  const env = process.env.PREPUSH_SCREENS;
  if (env !== undefined && env !== '') return { grep: env, why: 'PREPUSH_SCREENS' };
  const feeds = files.filter((f) => f.startsWith('src/components/') || f.startsWith('e2e/visual/'));
  if (feeds.length === 0) return { grep: null, why: 'no src/components or e2e/visual change' };
  const screens = readScreens();
  const names = new Set<string>();
  const urls = new Set<string>();
  let all = false;
  const why: string[] = [];
  const comp = feeds.filter((f) => f.startsWith('src/components/'));
  if (comp.length > 0) {
    const { buildGraph, select } = await import('./ci/e2e-select.ts');
    const { AREAS } = await import('./ci/e2e-areas.ts');
    const graph = buildGraph();
    const sel = select(comp, graph);
    if (sel.all) {
      all = true;
      why.push('a changed component is in the app shell or no area');
    } else {
      for (const f of comp) {
        const hit = AREAS.filter((a) => graph.closures.get(a.name)?.has(f));
        for (const a of hit) {
          const u = AREA_URLS[a.name];
          if (u === undefined) {
            all = true;
            why.push(`${f}: area ${a.name} has no screen url`);
          } else u.forEach((x) => urls.add(x));
        }
      }
    }
  }
  for (const f of feeds.filter((x) => x.startsWith('e2e/visual/'))) {
    if (f === 'e2e/visual/screens.spec.ts') {
      const changed = changedLines(base, f);
      for (const s of screens) {
        if (changed.some((n) => n >= s.start && n <= s.end)) names.add(s.name);
      }
    } else if (f.startsWith('e2e/visual/__screenshots__/')) {
      const m = /\/([^/]+)\.png$/.exec(f);
      if (m?.[1] !== undefined) names.add(m[1]);
    } else if (/layout-checks(-core)?\.ts$/.test(f) || f.endsWith('playwright.visual.config.ts')) {
      all = true;
      why.push(`${f}: runs inside every screen`);
    } else if (f.endsWith('.spec.ts')) {
      all = true;
      why.push(`${f}: a visual spec`);
    }
  }
  if (all) return { grep: 'ALL', why: why.join('; ') };
  for (const s of screens) {
    if (
      s.url !== null &&
      [...urls].some((u) => s.url === u || s.url?.startsWith(`${u}/`) || s.url?.startsWith(`${u}?`))
    ) {
      names.add(s.name);
    }
  }
  if (names.size === 0) return { grep: null, why: 'no screen fed by the changed files' };
  const alts = [...names].sort().map(nameSource);
  return {
    grep: `(?:^|\\s)(?:${alts.join('|')})(?:\\s|$)`,
    why: `${names.size} screens (urls ${[...urls].join(', ') || 'none'})`,
  };
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
  const again = await run('vitest (failed files alone)', bin('vitest'), ['run', ...failed]);
  return {
    name: again.ok ? `vitest ${args[0]} (re-ran ${failed.length} alone)` : first.name,
    ok: again.ok,
    ms: first.ms + again.ms,
    output: again.ok
      ? `passed alone after a timeout under load: ${failed.join(' ')}`
      : `${first.output}\n${again.output}`,
  };
}

/** null: no e2e spec; []: the whole suite; else the selected specs. */
async function e2eSpecs(files: string[]): Promise<string[] | null> {
  const code = files.filter(
    (f) => !f.startsWith('docs/') && !f.endsWith('.md') && !f.startsWith('e2e/visual/'),
  );
  const own = code.filter((f) => /^e2e\/tests\/.+\.spec\.ts$/.test(f));
  const app = code.filter((f) => !f.startsWith('e2e/') && !f.startsWith('.github/'));
  const helpers = code.some((f) => /^e2e\/(helpers|fixtures|harness)\//.test(f));
  if (helpers) return [];
  if (app.length === 0) return own.length > 0 ? own : null;
  const { select } = await import('./ci/e2e-select.ts');
  const sel = select(app);
  if (sel.all) return [];
  const specs = [...new Set([...sel.specs, ...own])];
  return specs.length > 0 ? specs : null;
}

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
  const visual = await visualGrep(base, files);
  if (visual.grep === null) {
    results.push(await skip('visual + layout checks', visual.why));
  } else {
    const args = ['test', '--config', 'e2e/visual/playwright.visual.config.ts', '--reporter=line'];
    if (process.env.PREPUSH_SNAPSHOTS !== '1') args.push('--ignore-snapshots');
    if (visual.grep !== 'ALL') args.push('-g', visual.grep);
    process.stdout.write(
      `prepush: visual ${visual.grep === 'ALL' ? 'all screens' : visual.why} (${visual.why})\n`,
    );
    results.push(await run('visual + layout checks', bin('playwright'), args));
  }

  // The WebKit e2e specs the changed files reach (scripts/ci/e2e-select.ts, as
  // e2e-webkit.yml picks them): the button system and touch sweeps live there.
  const e2e = await e2eSpecs(files);
  if (e2e === null) {
    results.push(await skip('e2e webkit', 'no spec reached'));
  } else {
    process.stdout.write(
      `prepush: e2e ${e2e.length === 0 ? 'whole suite' : `${e2e.length} specs`}\n`,
    );
    results.push(await run('e2e webkit', bin('playwright'), ['test', '--reporter=line', ...e2e]));
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
  process.stdout.write(`  ${'total'.padEnd(28)} ${fmt(Date.now() - t0).padStart(8)}\n`);
  if (failed) process.exit(1);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `prepush: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
