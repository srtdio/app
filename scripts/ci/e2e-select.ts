// Picks the WebKit e2e specs a set of changed files can reach.
//
//   node --experimental-strip-types scripts/ci/e2e-select.ts <file>...
//   git diff --name-only main | node --experimental-strip-types scripts/ci/e2e-select.ts
//
// stdout: "ALL" (run the whole suite) or one spec path per line (none = run
// nothing). stderr: which rule chose what, per file. Paths are repo-relative.
//
// Each area in e2e-areas.ts has an import closure, walked from its entries
// with the TypeScript compiler's own import scanner and module resolution
// (tsconfig.json paths, '@/' included). A changed file selects the specs of
// every area whose closure holds it. The whole suite runs for anything in the
// app shell's closure, anything in ALWAYS_FULL, and any file no closure
// reaches (unknown files stay safe). A file that sets a data-induction anchor
// also runs the onboarding tour walks (INDUCTION_ANCHOR_SPECS).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import {
  ALWAYS_FULL,
  AREAS,
  FULL_EXTENSIONS,
  INDUCTION_ANCHOR_MARK,
  INDUCTION_ANCHOR_SPECS,
  SHELL_ROOTS,
  type Area,
} from './e2e-areas.ts';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export interface Selection {
  all: boolean;
  specs: string[];
  /** One line per changed file: the rule that decided it. */
  log: string[];
}

export interface Graph {
  shell: Set<string>;
  closures: Map<string, Set<string>>;
}

const toRel = (abs: string): string => path.relative(REPO_ROOT, abs).split(path.sep).join('/');

function compilerOptions(): ts.CompilerOptions {
  const configPath = path.join(REPO_ROOT, 'tsconfig.json');
  const read = ts.readConfigFile(configPath, (p) => ts.sys.readFile(p));
  if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
  return ts.parseJsonConfigFileContent(read.config, ts.sys, REPO_ROOT, undefined, configPath)
    .options;
}

/** The repo files `file` imports (static, dynamic, type-only, CSS @import). */
function makeImportsOf(options: ts.CompilerOptions): (abs: string) => string[] {
  const host = ts.createCompilerHost(options);
  const cache = new Map<string, string[]>();
  const srcDir = path.join(REPO_ROOT, 'src');

  // Vite-only specifiers (CSS, ?url, ?raw, assets) the TS resolver skips.
  const resolveFile = (spec: string, from: string): string | undefined => {
    const bare = spec.replace(/[?#].*$/, '');
    let base: string | undefined;
    if (bare.startsWith('@/')) base = path.join(srcDir, bare.slice(2));
    else if (bare.startsWith('.')) base = path.resolve(path.dirname(from), bare);
    if (!base) return undefined;
    return existsSync(base) && statSync(base).isFile() ? base : undefined;
  };

  return (abs) => {
    const hit = cache.get(abs);
    if (hit) return hit;
    const out: string[] = [];
    cache.set(abs, out);
    const text = readFileSync(abs, 'utf8');
    const specs: string[] = [];
    if (abs.endsWith('.css')) {
      for (const m of text.matchAll(/@import\s+(?:url\()?\s*['"]([^'"]+)['"]/g)) {
        if (m[1]) specs.push(m[1]);
      }
    } else {
      const info = ts.preProcessFile(text, true, true);
      for (const ref of info.importedFiles) specs.push(ref.fileName);
    }
    for (const spec of specs) {
      const res = ts.resolveModuleName(spec, abs, options, host).resolvedModule;
      let file =
        res && !res.isExternalLibraryImport ? path.resolve(res.resolvedFileName) : undefined;
      if (!file) file = resolveFile(spec, abs);
      if (!file) continue;
      const rel = toRel(file);
      if (rel.startsWith('..') || rel.includes('node_modules/') || rel.endsWith('.d.ts')) continue;
      out.push(file);
    }
    return out;
  };
}

function walk(
  roots: string[],
  importsOf: (abs: string) => string[],
  stop: Set<string> = new Set(),
): Set<string> {
  const seen = new Set<string>();
  const queue = roots.map((r) => path.join(REPO_ROOT, r));
  while (queue.length > 0) {
    const abs = queue.pop();
    if (abs === undefined) break;
    const rel = toRel(abs);
    if (seen.has(rel)) continue;
    if (!existsSync(abs)) throw new Error(`e2e-select: missing file in the area table: ${rel}`);
    seen.add(rel);
    for (const next of importsOf(abs)) if (!stop.has(toRel(next))) queue.push(next);
  }
  return seen;
}

export function buildGraph(areas: Area[] = AREAS, shellRoots: string[] = SHELL_ROOTS): Graph {
  const importsOf = makeImportsOf(compilerOptions());
  const stop = new Set(areas.filter((a) => a.routed).flatMap((a) => a.entries));
  const shell = walk(shellRoots, importsOf, stop);
  const closures = new Map<string, Set<string>>();
  for (const area of areas) closures.set(area.name, walk(area.entries, importsOf));
  return { shell, closures };
}

/** Every spec in e2e/tests must be listed by an area; throws naming the strays. */
export function checkSpecCoverage(areas: Area[] = AREAS): void {
  const dir = path.join(REPO_ROOT, 'e2e/tests');
  const onDisk = readdirSync(dir)
    .filter((f) => f.endsWith('.spec.ts'))
    .map((f) => `e2e/tests/${f}`);
  const listed = new Set(areas.flatMap((a) => a.specs));
  const unassigned = onDisk.filter((s) => !listed.has(s));
  const missing = [...listed].filter((s) => !onDisk.includes(s));
  const problems: string[] = [];
  if (unassigned.length > 0) {
    problems.push(
      `specs in no area (add them to scripts/ci/e2e-areas.ts): ${unassigned.join(' ')}`,
    );
  }
  if (missing.length > 0) problems.push(`area specs that do not exist: ${missing.join(' ')}`);
  if (problems.length > 0) throw new Error(`e2e-select: ${problems.join('; ')}`);
}

/** A changed file's text, or null when it no longer exists (a deletion). */
export function readRepoFile(rel: string): string | null {
  const abs = path.join(REPO_ROOT, rel);
  return existsSync(abs) && statSync(abs).isFile() ? readFileSync(abs, 'utf8') : null;
}

/** true when the file sets a data-induction anchor the tour may point at. */
export function setsInductionAnchor(text: string | null): boolean {
  return text !== null && INDUCTION_ANCHOR_MARK.test(text);
}

export function select(
  changed: string[],
  graph: Graph = buildGraph(),
  areas: Area[] = AREAS,
  readFile: (rel: string) => string | null = readRepoFile,
): Selection {
  const log: string[] = [];
  const specs = new Set<string>();
  let all = false;
  for (const raw of changed) {
    const file = raw.trim().replace(/^\.\//, '');
    if (!file) continue;
    if (setsInductionAnchor(readFile(file))) {
      for (const s of INDUCTION_ANCHOR_SPECS) specs.add(s);
      log.push(`${file}: sets a data-induction anchor, onboarding tour specs`);
    }
    if (ALWAYS_FULL.some((p) => (p.endsWith('/') ? file.startsWith(p) : file === p))) {
      log.push(`${file}: shared file, whole suite`);
      all = true;
      continue;
    }
    if (FULL_EXTENSIONS.some((ext) => file.endsWith(ext))) {
      log.push(`${file}: stylesheet, whole suite`);
      all = true;
      continue;
    }
    if (graph.shell.has(file)) {
      log.push(`${file}: in the app shell, whole suite`);
      all = true;
      continue;
    }
    let hit = areas.filter((a) => graph.closures.get(a.name)?.has(file));
    let how = 'imported by';
    if (hit.length === 0) {
      hit = areas.filter((a) => a.ownedDirs?.some((d) => file.startsWith(d)));
      how = 'in the folder of';
    }
    if (hit.length === 0) {
      log.push(`${file}: in no area (unknown or unreachable), whole suite`);
      all = true;
      continue;
    }
    const picked = hit.flatMap((a) => a.specs);
    for (const s of picked) specs.add(s);
    const names = hit.map((a) => a.name).join(', ');
    log.push(`${file}: ${how} ${names}: ${picked.length > 0 ? picked.length : 'no'} specs`);
  }
  return { all, specs: all ? [] : [...specs].sort(), log };
}

function main(): void {
  checkSpecCoverage();
  let files = process.argv.slice(2);
  if (files.length === 0 && !process.stdin.isTTY) {
    files = readFileSync(0, 'utf8').split('\n');
  }
  const result = select(files);
  for (const line of result.log) process.stderr.write(`e2e-select: ${line}\n`);
  process.stdout.write(result.all ? 'ALL\n' : result.specs.map((s) => `${s}\n`).join(''));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
