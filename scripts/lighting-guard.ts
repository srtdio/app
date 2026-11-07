// Lighting guard: counts every lit-* class (one role per class name: lit-card,
// lit-media, lit-header, lit-focus-inset, ...) across src/**/*.{ts,tsx} on
// origin/main and in the working tree, and fails when any role's count drops.
// The only allowed drops are the lit-* classes that lived in files deleted on
// purpose (DELETED_ON_PURPOSE). It also fails when src/index.css (where the
// lit-* recipes live) differs from main by a single byte.
//
//   node --experimental-strip-types --no-warnings scripts/lighting-guard.ts            check
//   node --experimental-strip-types --no-warnings scripts/lighting-guard.ts --verbose  + file:line lists
//
// The pure functions are exported for scripts/lighting-guard.test.ts.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BASE_REF = 'origin/main';
export const INDEX_CSS = 'src/index.css';

/**
 * Files deleted on purpose. Their lit-* classes may leave the count; every
 * other drop is a lighting regression. Only applies while the file is gone.
 */
export const DELETED_ON_PURPOSE: Record<string, string> = {
  'src/components/pages/pipeline/PipelineBoard.tsx':
    'Pipeline board view removed; Pipeline is a list of ListCard rows (lit-card on ListCard).',
  'src/components/pages/pipeline/board-columns.tsx': 'Board columns removed with the board view.',
  'src/components/pages/plan-tab/PlanCalendar.tsx':
    'Plan calendar view removed; Plan is a list of ListCard rows.',
  'src/components/pages/plan-tab/PlanDayMenu.tsx': 'Calendar day menu removed with the calendar.',
  'src/components/pages/plan-tab/PlanTabAdd.tsx':
    'Plan add picker removed; add goes through the shared Sheet.',
  'src/components/pages/assets/AssetCard.tsx':
    'Asset tile replaced by AssetListCard on ListCard (lit-card, lit-media, lit-selected live on ListCard).',
  'src/components/pages/assets/AssetGrid.tsx':
    'Asset grid replaced by the ListCard list (AssetListCard).',
  'src/components/pages/activity/AvatarStack.tsx':
    'Activity avatar stack replaced by the ListCard picture (Avatar lit-avatar).',
};

export interface Occurrence {
  role: string;
  file: string;
  line: number;
  /** The whole class token, variants included (focus-visible:lit-focus-inset). */
  token: string;
}

export type Counts = Record<string, number>;
export type FileMap = Record<string, string>;

/** Same file set as the design ratchet, minus the marketing home. */
export function isCounted(rel: string): boolean {
  const p = rel.split(sep).join('/');
  if (!p.startsWith('src/')) return false;
  if (!/\.(ts|tsx)$/.test(p) || p.endsWith('.d.ts')) return false;
  if (/\.(test|spec)\.(ts|tsx)$/.test(p) || p.includes('/__tests__/')) return false;
  if (p.startsWith('src/components/home/')) return false;
  return true;
}

// A lit-* class: not glued to a word or dash on the left (so data-lit-x and
// unlit-x never count), variants such as hover: or focus-visible: allowed.
const LIT = /(?<![\w-])((?:[\w-]+:)*)(lit-[a-z0-9]+(?:-[a-z0-9]+)*)/g;

/**
 * Blank out // and /* *\/ comments (prose that names a class lights nothing),
 * keeping every newline so line numbers hold. Strings and template literals
 * are kept as they are; a regex literal holding // is rare enough to ignore.
 */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  // Stack of open quotes; '}' marks a ${ } inside a template literal.
  const stack: string[] = [];
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    const top = stack[stack.length - 1];
    if (top === "'" || top === '"' || top === '`') {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (c === top) stack.pop();
      else if (top === '`' && c === '$' && next === '{') {
        out += '{';
        stack.push('}');
        i += 2;
        continue;
      } else if (top !== '`' && c === '\n') stack.pop();
      i++;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') stack.push(c);
    else if ((top === '}' || top === '{') && c === '{') stack.push('{');
    else if ((top === '}' || top === '{') && c === '}') stack.pop();
    out += c;
    i++;
  }
  return out;
}

export function scanSource(file: string, src: string): Occurrence[] {
  const out: Occurrence[] = [];
  const lines = stripComments(src).split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i]!.matchAll(LIT)) {
      out.push({ role: m[2]!, file, line: i + 1, token: `${m[1] ?? ''}${m[2]!}` });
    }
  }
  return out;
}

export function scanFiles(files: FileMap): Occurrence[] {
  const out: Occurrence[] = [];
  for (const file of Object.keys(files).sort()) {
    if (!isCounted(file)) continue;
    out.push(...scanSource(file, files[file]!));
  }
  return out;
}

export function countRoles(occ: Occurrence[]): Counts {
  const counts: Counts = {};
  for (const o of occ) counts[o.role] = (counts[o.role] ?? 0) + 1;
  return counts;
}

export interface RoleRow {
  role: string;
  main: number;
  branch: number;
  /** Count that left with files in DELETED_ON_PURPOSE. */
  allowed: number;
  ok: boolean;
}

export interface Comparison {
  rows: RoleRow[];
  drops: RoleRow[];
  /** Allowlisted files that are actually gone on the branch. */
  deleted: string[];
}

export function compareLighting(
  main: FileMap,
  branch: FileMap,
  allow: Record<string, string> = DELETED_ON_PURPOSE,
): Comparison {
  const mainOcc = scanFiles(main);
  const mainCounts = countRoles(mainOcc);
  const branchCounts = countRoles(scanFiles(branch));
  const deleted = Object.keys(allow).filter((f) => f in main && !(f in branch));
  const gone = new Set(deleted);
  const allowedCounts = countRoles(mainOcc.filter((o) => gone.has(o.file)));
  const roles = [...new Set([...Object.keys(mainCounts), ...Object.keys(branchCounts)])].sort();
  const rows = roles.map((role) => {
    const m = mainCounts[role] ?? 0;
    const b = branchCounts[role] ?? 0;
    const a = allowedCounts[role] ?? 0;
    return { role, main: m, branch: b, allowed: a, ok: b >= m - a };
  });
  return { rows, drops: rows.filter((r) => !r.ok), deleted };
}

export interface Change {
  sign: '+' | '-';
  occ: Occurrence;
  /** Per-file change in this role's count. */
  delta: number;
}

/**
 * Every file whose count of a role changed. For a drop, the main occurrences
 * of that role in that file are listed with '-'; for a rise, the branch ones
 * with '+'. A file can drop one role and gain another.
 */
export function diffOccurrences(main: FileMap, branch: FileMap): Change[] {
  const byFileRole = (occ: Occurrence[]) => {
    const map = new Map<string, Occurrence[]>();
    for (const o of occ) {
      const k = `${o.file}\u0000${o.role}`;
      const list = map.get(k) ?? [];
      list.push(o);
      map.set(k, list);
    }
    return map;
  };
  const m = byFileRole(scanFiles(main));
  const b = byFileRole(scanFiles(branch));
  const out: Change[] = [];
  for (const k of [...new Set([...m.keys(), ...b.keys()])].sort()) {
    const before = m.get(k) ?? [];
    const after = b.get(k) ?? [];
    const delta = after.length - before.length;
    if (delta < 0) for (const occ of before) out.push({ sign: '-', occ, delta });
    if (delta > 0) for (const occ of after) out.push({ sign: '+', occ, delta });
  }
  return out;
}

export function formatTable(rows: RoleRow[]): string[] {
  const w = Math.max(4, ...rows.map((r) => r.role.length));
  return rows.map((r) => {
    const note = r.allowed > 0 ? `  (${r.allowed} from deleted files)` : '';
    const flag = r.ok ? '' : '  DROP';
    return `${r.role.padEnd(w)}  ${String(r.main).padStart(4)} -> ${String(r.branch).padStart(4)}${note}${flag}`;
  });
}

// ---------------------------------------------------------------- repo I/O

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

export function readMain(root: string, ref = BASE_REF): FileMap {
  const files: FileMap = {};
  const names = git(root, ['ls-tree', '-r', '--name-only', ref, 'src'])
    .split('\n')
    .filter((p) => p && isCounted(p));
  for (const p of names) files[p] = git(root, ['show', `${ref}:${p}`]);
  return files;
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
}

export function readBranch(root: string): FileMap {
  const files: FileMap = {};
  const all: string[] = [];
  const srcDir = join(root, 'src');
  if (existsSync(srcDir)) walk(srcDir, all);
  for (const full of all) {
    const rel = relative(root, full).split(sep).join('/');
    if (isCounted(rel)) files[rel] = readFileSync(full, 'utf8');
  }
  return files;
}

export interface RunOptions {
  root: string;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

export function run(argv: string[], opts: RunOptions): number {
  const log = opts.log ?? ((l: string) => process.stdout.write(`${l}\n`));
  const error = opts.error ?? ((l: string) => process.stderr.write(`${l}\n`));
  const verbose = argv.includes('--verbose');

  const main = readMain(opts.root);
  const branch = readBranch(opts.root);
  const cmp = compareLighting(main, branch);

  log(`Lighting roles, ${BASE_REF} -> working tree:`);
  for (const l of formatTable(cmp.rows)) log(`  ${l}`);
  if (cmp.deleted.length > 0) {
    log('\nDeleted on purpose (their lit-* may leave the count):');
    for (const f of cmp.deleted) log(`  ${f}: ${DELETED_ON_PURPOSE[f]}`);
  }

  if (verbose) {
    const changes = diffOccurrences(main, branch);
    log(changes.length > 0 ? '\nChanged lit-* occurrences (per file and role):' : '\nNo lit-* changes.');
    for (const c of changes) {
      const d = c.delta > 0 ? `+${c.delta}` : String(c.delta);
      log(`  ${c.sign} ${c.occ.file}:${c.occ.line}  ${c.occ.token}  (file ${d})`);
    }
  }

  let code = 0;
  const cssMain = git(opts.root, ['show', `${BASE_REF}:${INDEX_CSS}`]);
  const cssPath = join(opts.root, INDEX_CSS);
  const cssBranch = existsSync(cssPath) ? readFileSync(cssPath, 'utf8') : '';
  if (cssMain !== cssBranch) {
    error(`\nLighting guard: ${INDEX_CSS} differs from ${BASE_REF}. Lighting recipes are locked.`);
    code = 1;
  }
  if (cmp.drops.length > 0) {
    for (const r of cmp.drops) {
      error(
        `\nLighting guard: ${r.role} dropped ${r.main} -> ${r.branch}` +
          (r.allowed > 0 ? ` (only ${r.allowed} came from files deleted on purpose)` : '') +
          '.',
      );
    }
    error('Put the class back on the element, or on the part that took its place.');
    code = 1;
  }
  if (code === 0) log('\nLighting guard: ok.');
  return code;
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  process.exitCode = run(process.argv.slice(2), { root });
}
