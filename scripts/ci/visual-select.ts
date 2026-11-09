// Picks the visual screens (e2e/visual) a set of changed files can change.
// One copy, used by pnpm prepush (scripts/prepush.ts) and Visual CI
// (.github/workflows/visual-ci.yml).
//
//   node --experimental-strip-types scripts/ci/visual-select.ts [--base REF] [--head REF] [--github-output]
//
// --base defaults to the merge base with origin/main; without --head the
// working tree (untracked files included) is the new side. stdout: "ALL" or
// the playwright -g regex of the selected screens ("" = no screen). stderr:
// the reasons and the names. --github-output also writes mode (all | some |
// none), grep and count to $GITHUB_OUTPUT. Any error in the selection is ALL.
//
// Rules, per changed file:
// - ALL (FORCE_ALL): global CSS, fonts, design tokens, tailwind / postcss /
//   vite config, index.html, package.json, pnpm-lock.yaml, tsconfig, the app
//   shell (src/main.tsx, src/App.tsx router, src/components/shell/ layout
//   root, and code only the shell reaches),
//   e2e/visual/layout-checks*.ts, playwright.visual.config.ts, shared code
//   in screens.spec.ts / onboarding-steps.ts (lines outside any screen entry),
//   the e2e harness, this selector and its area map, visual-ci.yml; and any
//   file no rule knows (unknown files stay safe).
// - Nothing: docs, markdown, scripts/, supabase/, tests/, workers/,
//   src/server/, unit tests, e2e/tests, other workflows, repo tooling, and
//   packages/ code no screen area imports.
// - A screen's own lines or its baseline PNG: that screen.
// - src/ and packages/ code: the screens of every e2e area (scripts/ci/
//   e2e-areas.ts) whose import closure holds it; an area with no screen adds
//   one smoke screen per area instead of ALL.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const SPEC_FILE = 'e2e/visual/screens.spec.ts';
export const ONBOARDING_FILE = 'e2e/visual/onboarding-steps.ts';
export const SCREEN_FILES = [SPEC_FILE, ONBOARDING_FILE];
export const CHECK_FILES = ['e2e/visual/layout-checks.ts', 'e2e/visual/layout-checks-core.ts'];

/** Most screens a local run renders (pnpm prepush); the full set runs in CI. */
export const SCREEN_CAP = 12;

/** CI runs one shard at or under this many selected screens. */
export const ONE_SHARD_MAX = 20;

/**
 * The screens of each e2e area (scripts/ci/e2e-areas.ts names), in smoke
 * order: by url (exact, or followed by / or ?) or by screen-name prefix.
 * 'smoke' (src/index.css) has no screen of its own: CSS runs ALL.
 */
export const AREA_SCREENS: Readonly<
  Record<string, { readonly urls?: readonly string[]; readonly prefixes?: readonly string[] }>
> = {
  onboarding: { prefixes: ['onboarding-'] },
  chat: { urls: ['/chat'] },
  notifications: { urls: ['/activity'] },
  'plan-tab': { urls: ['/plan'] },
  pipeline: { urls: ['/pipeline'] },
  pcs: { urls: ['/posts'] },
  briefs: { urls: ['/briefs'] },
  assets: { urls: ['/assets', '/deleted'] },
  settings: { urls: ['/settings'] },
  unvisited: { urls: ['/help', '/signin', '/signup'] },
  home: { urls: ['/', '/pricing', '/demo'] },
  unsubscribe: { urls: ['/unsubscribe'] },
  smoke: {},
};

/** Paths that always run ALL (besides the app shell's closure and screens-file shared lines). */
export const FORCE_ALL: readonly RegExp[] = [
  /\.css$/,
  /\.(woff2?|ttf|otf)$/,
  /(^|\/)fonts?\//,
  /^src\/styles\//,
  /^src\/lib\/motion\/tokens\.ts$/,
  /^tailwind\.config\.ts$/,
  /^postcss\.config\.js$/,
  /^vite\.config\.ts$/,
  /^index\.html$/,
  /(^|\/)package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /^tsconfig[^/]*\.json$/,
  /^src\/main\.tsx$/,
  /^src\/App\.tsx$/,
  /^src\/components\/shell\//,
  /^e2e\/harness\//,
  /^e2e\/fixtures\//,
  /^e2e\/visual\/layout-checks(-core)?\.ts$/,
  /^e2e\/visual\/playwright\.visual\.config\.ts$/,
  /^scripts\/ci\/(visual-select|e2e-areas|e2e-select)\.ts$/,
  /^\.github\/workflows\/visual-ci\.yml$/,
];

/** Unit tests and their snapshots: no screen renders them (checked before FORCE_ALL). */
const TEST_FILE = /\.test\.tsx?$|(^|\/)__tests__\/|(^|\/)__snapshots__\/|\.snap$/;

/** Paths no screen renders. */
export const NO_SCREEN: readonly RegExp[] = [
  /^docs\//,
  /\.md$/,
  /^scripts\//,
  /^supabase\//,
  /^tests\//,
  /^workers\//,
  /^src\/server\//,
  /\.test\.tsx?$/,
  /^src\/__tests__\//,
  /(^|\/)__snapshots__\/|\.snap$/,
  /^e2e\/tests\//,
  /^\.github\//,
  /^\.claude\//,
  /^\.(gitignore|nvmrc|npmrc|prettierrc[^/]*|prettierignore|editorconfig|env\.example)$/,
  /^eslint\.config\.[cm]?[jt]s$/,
  /^vitest\.config\.ts$/,
  /^playwright\.config\.ts$/,
  /^public\/(_headers|_redirects)$/,
];

export interface ScreenDef {
  name: string;
  url: string | null;
  /** The file that defines it (screens.spec.ts or onboarding-steps.ts). */
  file: string;
  start: number;
  end: number;
}

/** Each screen entry in a screens file: name, url and line span (1-based, inside its array). */
export function parseScreens(source: string, file: string = SPEC_FILE): ScreenDef[] {
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
    out.push({ name: m[1], url, file, start: i + 1, end: i + 1 });
  });
  out.forEach((s, k) => {
    // A span ends before the next screen or where its array closes.
    let end = (out[k + 1]?.start ?? src.length + 1) - 1;
    for (let n = s.start + 1; n <= end; n += 1) {
      if (/^\];?\s*$|^\]\)/.test(src[n - 1] ?? '')) {
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

/** The -g regex for a set of screen names (each title is the name, maybe + tags). */
export const screensGrep = (names: readonly string[]): string =>
  `(?:^|\\s)(?:${[...names].sort().map(nameSource).join('|')})(?:\\s|$)`;

/** The screen entry a literal or template name belongs to. */
function screenOf(screens: readonly ScreenDef[], name: string): ScreenDef | undefined {
  return (
    screens.find((s) => s.name === name) ??
    screens.find((s) => new RegExp(`^${nameSource(s.name)}$`).test(name))
  );
}

const urlIn = (url: string, prefixes: readonly string[]): boolean =>
  prefixes.some((u) =>
    u === '/'
      ? url === '/' || url.startsWith('/?')
      : url === u || url.startsWith(`${u}/`) || url.startsWith(`${u}?`),
  );

/** The AREA_SCREENS key a screen belongs to, else 'other'. */
export function areaOfScreen(s: Pick<ScreenDef, 'name' | 'url'> | undefined): string {
  if (s === undefined) return 'other';
  for (const [area, m] of Object.entries(AREA_SCREENS)) {
    if (m.prefixes?.some((p) => s.name.startsWith(p)) === true) return area;
  }
  for (const [area, m] of Object.entries(AREA_SCREENS)) {
    if (s.url !== null && m.urls !== undefined && urlIn(s.url, m.urls)) return area;
  }
  return 'other';
}

/** The screens of one area. */
export function screensOfArea(screens: readonly ScreenDef[], area: string): ScreenDef[] {
  return screens.filter((s) => areaOfScreen(s) === area);
}

/** One screen per area: the area's plain page (url exactly an area url), else its first screen. */
export function smokeScreens(screens: readonly ScreenDef[]): string[] {
  return Object.entries(AREA_SCREENS)
    .map(([area, m]) => {
      const own = screensOfArea(screens, area);
      return (own.find((s) => s.url !== null && m.urls?.includes(s.url) === true) ?? own[0])?.name;
    })
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
  sources: Readonly<Record<string, string>>,
): Set<string> {
  const names = new Set<string>();
  if (checks.size === 0) return names;
  for (const s of screens) {
    const body = (sources[s.file] ?? '')
      .split('\n')
      .slice(s.start - 1, s.end)
      .join('\n');
    if ([...checks].some((c) => mentions(body, c))) names.add(s.name);
  }
  const src = (sources[SPEC_FILE] ?? '').split('\n');
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

/** What the import graph says about one file (scripts/ci/e2e-select.ts closures). */
export interface GraphView {
  inShell: (file: string) => boolean;
  /** The e2e areas whose import closure holds the file. */
  areasOf: (file: string) => string[];
}

export interface VisualInput {
  files: readonly string[];
  /** Repo path -> source, for SCREEN_FILES and CHECK_FILES (new side). */
  sources: Readonly<Record<string, string>>;
  /** Changed line numbers (new side) per file. */
  changedLines: (file: string) => number[];
  /** Built lazily: only src/ or packages/ code needs it. */
  graph: () => GraphView;
}

export interface VisualSelection {
  all: boolean;
  /** Screens to run when not all (template names allowed); empty: none. */
  names: string[];
  /** The screens this diff aims at even when all (local runs start from these). */
  targeted: string[];
  reasons: string[];
}

const CODE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

export function selectVisual(input: VisualInput): VisualSelection {
  const screens = SCREEN_FILES.flatMap((f) =>
    input.sources[f] !== undefined ? parseScreens(input.sources[f] ?? '', f) : [],
  );
  const names = new Set<string>();
  const reasons: string[] = [];
  let all = false;
  let smoke = false;
  const force = (why: string): void => {
    all = true;
    reasons.push(`ALL: ${why}`);
  };
  const changedChecks: Record<string, number[]> = {};
  let graph: GraphView | undefined;
  for (const f of input.files) {
    if (f.startsWith('e2e/visual/__screenshots__/')) {
      const m = /\/([^/]+)\.png$/.exec(f);
      if (m?.[1] !== undefined && screenOf(screens, m[1]) !== undefined) {
        names.add(m[1]);
        reasons.push(`${f}: its screen`);
      } else force(`${f}: a baseline of no known screen`);
    } else if (SCREEN_FILES.includes(f)) {
      const lines = (input.sources[f] ?? '').split('\n');
      const own = screens.filter((s) => s.file === f);
      let shared = false;
      for (const n of input.changedLines(f)) {
        const s = own.find((x) => n >= x.start && n <= x.end);
        if (s !== undefined) {
          names.add(s.name);
          continue;
        }
        if ((lines[n - 1] ?? '').trim() === '') continue;
        force(`${f}:${n}: shared code outside any screen entry`);
        shared = true;
        break;
      }
      if (!shared) reasons.push(`${f}: the edited screen entries`);
    } else if (CHECK_FILES.includes(f)) {
      changedChecks[f] = input.changedLines(f);
      force(`${f}: layout checks run inside every screen`);
    } else if (TEST_FILE.test(f)) {
      continue;
    } else if (FORCE_ALL.some((r) => r.test(f))) {
      force(f);
    } else if (NO_SCREEN.some((r) => r.test(f))) {
      continue;
    } else if ((f.startsWith('src/') || f.startsWith('packages/')) && CODE.test(f)) {
      graph ??= input.graph();
      const areas = graph.areasOf(f);
      if (areas.length === 0) {
        if (graph.inShell(f)) force(`${f}: only the app shell reaches it`);
        else if (!f.startsWith('packages/')) force(`${f}: no area reaches it`);
        continue;
      }
      for (const a of areas) {
        const own = screensOfArea(screens, a);
        if (own.length === 0) {
          smoke = true;
          reasons.push(`${f}: area ${a} has no screen, one smoke screen per area`);
        } else {
          own.forEach((s) => names.add(s.name));
          reasons.push(`${f}: area ${a} (${own.length} screens)`);
        }
      }
    } else {
      force(`${f}: unknown file`);
    }
  }
  if (Object.keys(changedChecks).length > 0) {
    const checks = affectedChecks(
      Object.fromEntries(CHECK_FILES.map((f) => [f, input.sources[f] ?? ''])),
      changedChecks,
      input.sources[SPEC_FILE] ?? '',
    );
    screensForChecks(checks, screens, input.sources).forEach((n) => names.add(n));
  }
  if (smoke) smokeScreens(screens).forEach((n) => names.add(n));
  const targeted = [...names];
  return { all, names: all ? [] : targeted, targeted, reasons };
}

/**
 * The local (prepush) run: never ALL, never more than the cap. Targeted
 * screens first, then (when CI runs ALL) one smoke screen per area not yet
 * covered; inside each tier a round robin over areas, spec order inside one.
 */
export function localScreens(
  sel: VisualSelection,
  screens: readonly ScreenDef[],
  cap: number = SCREEN_CAP,
): { names: string[]; picked: number } {
  const smoke = sel.all ? smokeScreens(screens) : [];
  const first = roundRobin(sel.targeted, screens, cap);
  const covered = new Set(first.map((n) => areaOfScreen(screenOf(screens, n))));
  const rest = smoke.filter(
    (n) => !first.includes(n) && !covered.has(areaOfScreen(screenOf(screens, n))),
  );
  const names = [...first, ...roundRobin(rest, screens, cap - first.length)];
  return { names, picked: new Set([...sel.targeted, ...smoke]).size };
}

function roundRobin(
  names: readonly string[],
  screens: readonly ScreenDef[],
  cap: number,
): string[] {
  const order = [...Object.keys(AREA_SCREENS), 'other'];
  const pos = (n: string): number => {
    const s = screenOf(screens, n);
    return s === undefined ? Number.MAX_SAFE_INTEGER : SCREEN_FILES.indexOf(s.file) * 1e6 + s.start;
  };
  const groups = order.map((area) =>
    names
      .filter((n) => areaOfScreen(screenOf(screens, n)) === area)
      .sort((a, b) => pos(a) - pos(b)),
  );
  const out: string[] = [];
  const want = Math.min(Math.max(cap, 0), names.length);
  for (let round = 0; out.length < want; round += 1) {
    for (const g of groups) {
      const n = g[round];
      if (n !== undefined && out.length < want) out.push(n);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The repo side: git, files, the import graph.

const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
const lines = (s: string): string[] => s.split('\n').filter((l) => l.trim() !== '');

export function defaultBase(): string {
  try {
    return git('merge-base', 'origin/main', 'HEAD');
  } catch {
    return 'origin/main';
  }
}

/** Changed files (deletions apart) between base and head (or the working tree). */
export function changedFiles(base: string, head?: string): string[] {
  const range = head === undefined ? [base] : [base, head];
  const all = lines(git('diff', '--name-only', ...range));
  const gone = new Set(lines(git('diff', '--name-only', '--diff-filter=D', ...range)));
  const untracked =
    head === undefined ? lines(git('ls-files', '--others', '--exclude-standard')) : [];
  return [...new Set([...all, ...untracked])].filter((f) => !gone.has(f)).sort();
}

export function diffLines(base: string, file: string, head?: string): number[] {
  const diff = git('diff', '-U0', base, ...(head === undefined ? [] : [head]), '--', file);
  const out: number[] = [];
  for (const m of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    for (let k = 0; k < Math.max(count, 1); k += 1) out.push(start + k);
  }
  return out;
}

function readSource(file: string, head?: string): string | undefined {
  try {
    if (head !== undefined)
      return execFileSync('git', ['show', `${head}:${file}`], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    const abs = path.join(ROOT, file);
    return existsSync(abs) ? readFileSync(abs, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}

/** The screens defined on the new side. */
export function readScreenDefs(head?: string): ScreenDef[] {
  return SCREEN_FILES.flatMap((f) => {
    const src = readSource(f, head);
    return src === undefined ? [] : parseScreens(src, f);
  });
}

/** Selection for a diff in this repo; an error selects ALL. */
export async function selectForDiff(
  base: string,
  head?: string,
  files: readonly string[] = changedFiles(base, head),
): Promise<VisualSelection> {
  try {
    const { buildGraph } = await import('./e2e-select.ts');
    const sources: Record<string, string> = {};
    for (const f of [...SCREEN_FILES, ...CHECK_FILES]) {
      const s = readSource(f, head);
      if (s !== undefined) sources[f] = s;
    }
    return selectVisual({
      files,
      sources,
      changedLines: (f) => diffLines(base, f, head),
      graph: () => {
        const g = buildGraph();
        return {
          inShell: (f) => g.shell.has(f),
          areasOf: (f) => [...g.closures].filter(([, c]) => c.has(f)).map(([a]) => a),
        };
      },
    });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return { all: true, names: [], targeted: [], reasons: [`ALL: selection error: ${why}`] };
  }
}

async function main(argv: string[]): Promise<void> {
  const opt = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const base = opt('--base') ?? defaultBase();
  const head = opt('--head');
  const sel = await selectForDiff(base, head);
  const grep = sel.all ? 'ALL' : sel.names.length > 0 ? screensGrep(sel.names) : '';
  for (const r of sel.reasons) process.stderr.write(`${r}\n`);
  process.stderr.write(
    sel.all
      ? `visual-select: ALL (targeted ${sel.targeted.length})\n`
      : `visual-select: ${sel.names.length} screens: ${[...sel.names].sort().join(' ')}\n`,
  );
  process.stdout.write(`${grep}\n`);
  const out = process.env.GITHUB_OUTPUT;
  if (argv.includes('--github-output') && out !== undefined && out !== '') {
    const mode = sel.all ? 'all' : sel.names.length > 0 ? 'some' : 'none';
    const count = sel.all ? readScreenDefs(head).length : sel.names.length;
    appendFileSync(out, `mode=${mode}\ngrep=${sel.all ? '' : grep}\ncount=${count}\n`);
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    // An error selects ALL, never nothing.
    process.stderr.write(`visual-select: ${err instanceof Error ? err.message : String(err)}\n`);
    process.stdout.write('ALL\n');
    const out = process.env.GITHUB_OUTPUT;
    if (process.argv.includes('--github-output') && out !== undefined && out !== '') {
      appendFileSync(out, 'mode=all\ngrep=\ncount=0\n');
    }
  });
}
