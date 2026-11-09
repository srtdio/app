// Pre-push gate: the checks CI runs, on the files this branch changed, on the
// exact tree (working tree, staged and untracked included) before a push.
//
//   pnpm prepush
//   PREPUSH_BASE=origin/main      the ref to diff against (default: merge base with origin/main)
//   PREPUSH_SCREENS='a|b'         run exactly these visual screens (regex on the screen name)
//   PREPUSH_SNAPSHOTS=1           also compare screenshots (local renders never match CI's
//                                 WebKit image, so by default only the layout checks run)
//
// Fast by design (target under 5 min; a slower run prints a warning). Steps,
// each timed: prettier --check, eslint, tsc (app, node, and the scripts / e2e
// configs when those changed), vitest related --run (plus the tests that read
// source as text, as ci.yml does), the design ratchet, the layout checks on the
// screens the changed files feed (selectScreens), then the WebKit e2e specs
// those files reach (e2e-webkit.yml's split, then scripts/ci/e2e-select.ts;
// scripts/, docs and other non-UI paths run no spec, as in CI).
//
// Layout checks: never every screen, never more than SCREEN_CAP (12). A
// component runs the screens of the areas it feeds; a screen's own lines run
// that screen; a shared visual file (layout-checks*.ts, the visual config, a
// non-screens visual spec, shared code in screens.spec.ts) or a component in
// the shell or an area with no screen url runs the screens whose check code
// changed plus one screen per area. Above the cap the first 12 by area run
// (round robin) and the full set is left to Visual CI. Exit 1 when any step fails.
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
// Visual screen selection (layout checks only; the full set is CI's job)

/** Most screens a local run renders; above it the first ones by area run. */
export const SCREEN_CAP = 12;

/** Screen URL prefixes per e2e area (scripts/ci/e2e-areas.ts names), in smoke order. */
export const AREA_URLS: Readonly<Record<string, readonly string[]>> = {
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

export interface ScreenDef {
  name: string;
  url: string | null;
  start: number;
  end: number;
}

/** Each screen entry in screens.spec.ts: its name, url and line span (1-based, inside its array). */
export function parseScreens(source: string): ScreenDef[] {
  const src = source.split('\n');
  const out: ScreenDef[] = [];
  src.forEach((line, i) => {
    const m = /^\s*(?:\{ )?name: [`']([^`']+)[`'],?/.exec(line);
    if (m === null || m[1] === undefined) return;
    let url: string | null = null;
    for (let j = i; j < Math.min(src.length, i + 12); j += 1) {
      const u = /\burl: [`']([^`']*)[`']/.exec(src[j] ?? '');
      if (u !== null) {
        url = u[1] ?? null;
        break;
      }
      if (j > i && /^\s*(?:\{ )?name: /.test(src[j] ?? '')) break;
    }
    out.push({ name: m[1], url, start: i + 1, end: i + 1 });
  });
  out.forEach((s, k) => {
    // A span ends before the next screen or where its array closes.
    let end = (out[k + 1]?.start ?? src.length + 1) - 1;
    for (let n = s.start; n <= end; n += 1) {
      if (/^\];?\s*$|^\]\)/.test(src[n - 1] ?? '') && n > s.start) {
        end = n - 1;
        break;
      }
    }
    s.end = end;
  });
  return out;
}

/** A template name (`pipeline-${density}`) as a regex source. */
export const nameSource = (name: string): string =>
  name
    .split(/\$\{[^}]+\}/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\w-]+');

/** The screen entry a literal or template name belongs to. */
function screenOf(screens: readonly ScreenDef[], name: string): ScreenDef | undefined {
  return (
    screens.find((s) => s.name === name) ??
    screens.find((s) => new RegExp(`^${nameSource(s.name)}$`).test(name))
  );
}

/** The AREA_URLS key of a screen url, else 'other'. */
export function areaOf(url: string | null): string {
  if (url === null) return 'other';
  for (const [area, prefixes] of Object.entries(AREA_URLS)) {
    if (prefixes.some((u) => url === u || url.startsWith(`${u}/`) || url.startsWith(`${u}?`)))
      return area;
  }
  return 'other';
}

/** One screen per area: the area's plain page (url exactly an area url), else its first screen. */
export function smokeScreens(screens: readonly ScreenDef[]): string[] {
  return Object.entries(AREA_URLS)
    .map(
      ([area, urls]) =>
        (
          screens.find((s) => s.url !== null && urls.includes(s.url)) ??
          screens.find((s) => areaOf(s.url) === area)
        )?.name,
    )
    .filter((n): n is string => n !== undefined);
}

interface Decl {
  name: string;
  start: number;
  end: number;
  body: string;
}

/** Top-level declarations of a TS source with their line spans. */
function topDecls(source: string): Decl[] {
  const src = source.split('\n');
  const heads: { name: string; start: number }[] = [];
  src.forEach((line, i) => {
    const m =
      /^(?:export )?(?:declare )?(?:async )?(?:function\*? |const |let |type |interface |class |enum )(\w+)/.exec(
        line,
      );
    if (m?.[1] !== undefined) heads.push({ name: m[1], start: i + 1 });
  });
  return heads.map((h, k) => {
    const end = (heads[k + 1]?.start ?? src.length + 1) - 1;
    return { ...h, end, body: src.slice(h.start - 1, end).join('\n') };
  });
}

const mentions = (text: string, name: string): boolean =>
  new RegExp(`(?<![\\w.])${name}\\b`).test(text);

/**
 * The check functions a layout-checks*.ts diff touches: the declarations
 * holding a changed line, then every declaration (in those files or the
 * screens spec) that uses one, until nothing new turns up.
 */
export function affectedChecks(
  checkSources: Readonly<Record<string, string>>,
  changed: Readonly<Record<string, readonly number[]>>,
  specSource: string,
): Set<string> {
  const decls = [
    ...Object.values(checkSources).flatMap((src) => topDecls(src)),
    ...topDecls(specSource).filter((d) => d.name !== 'capture' && d.name !== 'SCREENS'),
  ];
  const hit = new Set<string>();
  for (const [file, src] of Object.entries(checkSources)) {
    const own = topDecls(src);
    for (const n of changed[file] ?? []) {
      const d = own.find((x) => n >= x.start && n <= x.end);
      if (d !== undefined) hit.add(d.name);
    }
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const d of decls) {
      if (hit.has(d.name)) continue;
      if ([...hit].some((h) => mentions(d.body, h))) {
        hit.add(d.name);
        grew = true;
      }
    }
  }
  return hit;
}

/** The quoted names a `const NAME = new Set([...])` or record literal in the spec lists. */
function listedNames(specLines: readonly string[], constName: string): string[] {
  const i = specLines.findIndex((l) => new RegExp(`^const ${constName}\\b`).test(l));
  if (i < 0) return [];
  const head = specLines[i] ?? '';
  if (/\]\);?\s*$|\};?\s*$/.test(head) && !/[[{]\s*$/.test(head)) {
    return [...head.matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '').filter((s) => s !== '');
  }
  const out: string[] = [];
  for (let j = i + 1; j < specLines.length; j += 1) {
    const line = specLines[j] ?? '';
    if (/^(\]\)|\})/.test(line)) break;
    const m = /^\s*'([^']+)'/.exec(line);
    if (m?.[1] !== undefined) out.push(m[1]);
  }
  return out;
}

/** Screens whose capture runs one of the given checks: called in its own entry, or gated in capture(). */
export function screensForChecks(
  checks: ReadonlySet<string>,
  screens: readonly ScreenDef[],
  specSource: string,
): Set<string> {
  const src = specSource.split('\n');
  const names = new Set<string>();
  if (checks.size === 0) return names;
  for (const s of screens) {
    const body = src.slice(s.start - 1, s.end).join('\n');
    if ([...checks].some((c) => mentions(body, c))) names.add(s.name);
  }
  const vars = new Map<string, string>();
  for (const line of src) {
    const v = /const (\w+) = (\w+)\[screen\.name\]/.exec(line);
    if (v?.[1] !== undefined && v[2] !== undefined) vars.set(v[1], v[2]);
    const call = /await (\w+)\(page/.exec(line)?.[1];
    if (call === undefined || !checks.has(call)) continue;
    const set = /(\w+)\.has\(screen\.name\)/.exec(line)?.[1];
    const prefix = /screen\.name\.startsWith\('([^']+)'\)/.exec(line)?.[1];
    const guard = /if \((\w+) !== undefined\)/.exec(line)?.[1];
    const record = guard !== undefined ? vars.get(guard) : undefined;
    for (const n of set !== undefined ? listedNames(src, set) : []) names.add(n);
    for (const n of record !== undefined ? listedNames(src, record) : []) names.add(n);
    if (prefix !== undefined) {
      for (const s of screens) if (s.name.startsWith(prefix)) names.add(s.name);
    }
  }
  return names;
}

/**
 * Up to the cap: the targeted screens first, then the smoke screens of areas
 * not yet covered; inside each tier a round robin over areas (AREA_URLS order,
 * then 'other'), spec order inside an area.
 */
export function capByArea(
  targeted: readonly string[],
  smoke: readonly string[],
  screens: readonly ScreenDef[],
  cap: number = SCREEN_CAP,
): string[] {
  const area = (n: string): string => areaOf(screenOf(screens, n)?.url ?? null);
  const first = roundRobin(targeted, screens, cap);
  const covered = new Set(first.map(area));
  const rest = smoke.filter((n) => !first.includes(n) && !covered.has(area(n)));
  return [...first, ...roundRobin(rest, screens, cap - first.length)];
}

function roundRobin(
  names: readonly string[],
  screens: readonly ScreenDef[],
  cap: number,
): string[] {
  const order = [...Object.keys(AREA_URLS), 'other'];
  const pos = (n: string): number => screenOf(screens, n)?.start ?? Number.MAX_SAFE_INTEGER;
  const groups = order.map((area) =>
    names
      .filter((n) => areaOf(screenOf(screens, n)?.url ?? null) === area)
      .sort((a, b) => pos(a) - pos(b)),
  );
  const out: string[] = [];
  for (let round = 0; out.length < Math.min(cap, names.length); round += 1) {
    for (const g of groups) {
      const n = g[round];
      if (n !== undefined && out.length < cap) out.push(n);
    }
  }
  return out;
}

export interface VisualInput {
  files: readonly string[];
  screens: readonly ScreenDef[];
  specSource: string;
  /** layout-checks.ts / layout-checks-core.ts sources by repo path. */
  checkSources: Readonly<Record<string, string>>;
  /** Changed line numbers (new side) per file. */
  changedLines: (file: string) => number[];
  /** Screen urls of the areas the changed components feed. */
  componentUrls: readonly string[];
  /** Why the components reach beyond their areas (app shell, an area with no screen url). */
  componentGlobal: readonly string[];
}

export interface VisualPlan {
  /** Screen names to run (template names allowed); empty: no visual run. */
  names: string[];
  /** How many were picked before the cap. */
  picked: number;
  why: string;
}

/**
 * The screens a local run renders for these changes. Component changes run
 * the screens of the areas they feed; a screen's own lines run that screen;
 * a shared visual file (layout-checks*.ts, the visual config, a non-screens
 * spec, shared code in screens.spec.ts) or a component reaching the shell or
 * an area with no screen url runs the screens whose check code changed plus
 * one screen per area. Never more than SCREEN_CAP: the full set runs in CI.
 */
export function selectScreens(input: VisualInput): VisualPlan {
  const feeds = input.files.filter(
    (f) => f.startsWith('src/components/') || f.startsWith('e2e/visual/'),
  );
  if (feeds.length === 0)
    return { names: [], picked: 0, why: 'no src/components or e2e/visual change' };
  const { screens } = input;
  const names = new Set<string>();
  const smoke: string[] = [...input.componentGlobal];
  const checkFiles = Object.keys(input.checkSources);
  const changedChecks: Record<string, number[]> = {};
  for (const f of feeds.filter((x) => x.startsWith('e2e/visual/'))) {
    if (f === 'e2e/visual/screens.spec.ts') {
      for (const n of input.changedLines(f)) {
        const s = screens.find((x) => n >= x.start && n <= x.end);
        if (s !== undefined) {
          names.add(s.name);
          continue;
        }
        const line = input.specSource.split('\n')[n - 1] ?? '';
        const listed = [...line.matchAll(/'([^']+)'/g)]
          .map((m) => m[1] ?? '')
          .filter((x) => screenOf(screens, x) !== undefined);
        if (listed.length > 0) listed.forEach((x) => names.add(x));
        else if (line.trim() !== '' && !smoke.includes(`${f}: shared code`))
          smoke.push(`${f}: shared code`);
      }
    } else if (f.startsWith('e2e/visual/__screenshots__/')) {
      const m = /\/([^/]+)\.png$/.exec(f);
      if (m?.[1] !== undefined) names.add(m[1]);
    } else if (checkFiles.includes(f)) {
      changedChecks[f] = input.changedLines(f);
      smoke.push(`${f}: shared check`);
    } else {
      smoke.push(`${f}: shared visual file`);
    }
  }
  if (Object.keys(changedChecks).length > 0) {
    const checks = affectedChecks(input.checkSources, changedChecks, input.specSource);
    screensForChecks(checks, screens, input.specSource).forEach((n) => names.add(n));
  }
  for (const s of screens) {
    if (s.url === null) continue;
    const url = s.url;
    if (
      input.componentUrls.some(
        (u) => url === u || url.startsWith(`${u}/`) || url.startsWith(`${u}?`),
      )
    )
      names.add(s.name);
  }
  const smokeNames = smoke.length > 0 ? smokeScreens(screens) : [];
  const all = [...new Set([...names, ...smokeNames])];
  if (all.length === 0) return { names: [], picked: 0, why: 'no screen fed by the changed files' };
  const capped = capByArea([...names], smokeNames, screens);
  const reasons = [
    `${all.length} screens`,
    input.componentUrls.length > 0 ? `urls ${input.componentUrls.join(', ')}` : '',
    smoke.length > 0 ? `smoke 1 per area: ${smoke.join('; ')}` : '',
    all.length > capped.length ? `capped at ${SCREEN_CAP}, full set runs in CI` : '',
  ].filter((r) => r !== '');
  return { names: capped, picked: all.length, why: reasons.join('; ') };
}

/** The -g regex for a set of screen names (each title is the name, maybe + tags). */
export const screensGrep = (names: readonly string[]): string =>
  `(?:^|\\s)(?:${[...names].sort().map(nameSource).join('|')})(?:\\s|$)`;

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

const CHECK_FILES = ['e2e/visual/layout-checks.ts', 'e2e/visual/layout-checks-core.ts'];

/** The repo side of selectScreens: reads the spec, the checks and the component graph. */
async function visualPlan(base: string, files: string[]): Promise<VisualPlan | { grep: string }> {
  const env = process.env.PREPUSH_SCREENS;
  if (env !== undefined && env !== '') return { grep: env };
  const read = (f: string): string => readFileSync(path.join(ROOT, f), 'utf8');
  const specSource = read('e2e/visual/screens.spec.ts');
  const componentUrls = new Set<string>();
  const componentGlobal: string[] = [];
  const comp = files.filter((f) => f.startsWith('src/components/'));
  if (comp.length > 0) {
    const { buildGraph, select } = await import('./ci/e2e-select.ts');
    const { AREAS } = await import('./ci/e2e-areas.ts');
    const graph = buildGraph();
    if (select(comp, graph).all) {
      componentGlobal.push('a changed component is in the app shell or no area');
    }
    for (const f of comp) {
      for (const a of AREAS.filter((x) => graph.closures.get(x.name)?.has(f))) {
        const u = AREA_URLS[a.name];
        if (u === undefined) {
          if (!componentGlobal.includes(`area ${a.name} has no screen url`))
            componentGlobal.push(`area ${a.name} has no screen url`);
        } else u.forEach((x) => componentUrls.add(x));
      }
    }
  }
  return selectScreens({
    files,
    screens: parseScreens(specSource),
    specSource,
    checkSources: Object.fromEntries(
      CHECK_FILES.filter((f) => existsSync(path.join(ROOT, f))).map((f) => [f, read(f)]),
    ),
    changedLines: (f) => changedLines(base, f),
    componentUrls: [...componentUrls],
    componentGlobal,
  });
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

/** null: no e2e spec; []: the whole suite; else the selected specs. */
async function e2eSpecs(files: string[]): Promise<string[] | null> {
  const { own, app, whole } = e2eReach(files);
  if (whole) return [];
  if (app.length === 0) return own.length > 0 ? own : null;
  const { select } = await import('./ci/e2e-select.ts');
  const sel = select(app);
  if (sel.all) return [];
  const specs = [...new Set([...sel.specs, ...own])];
  return specs.length > 0 ? specs : null;
}

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
    'grep' in visual ? visual.grep : visual.names.length > 0 ? screensGrep(visual.names) : null;
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
