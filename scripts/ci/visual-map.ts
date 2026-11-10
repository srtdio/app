// The screen-to-files map: which src/ and packages/ files each visual screen
// loads. capture() in e2e/visual/screens.spec.ts records the dev server
// requests of one screen and writes a fragment per screen per project under
// e2e/results/visual-map/; the nightly run (.github/workflows/visual-nightly.yml)
// merges every shard's fragments into e2e/visual/screen-files.json, which
// scripts/ci/visual-select.ts reads to select per screen.
//
//   node --experimental-strip-types scripts/ci/visual-map.ts merge <dir>... --out <file>
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const MAP_FILE = 'e2e/visual/screen-files.json';
export const FRAGMENT_DIR = 'e2e/results/visual-map';
/** The Vite harness root (e2e/harness/vite.config.ts): root-relative urls resolve here. */
const HARNESS = 'e2e/harness';

/** Screen name -> the repo files it loads, sorted. */
export type ScreenMap = Record<string, string[]>;

export interface Fragment {
  screen: string;
  project: string;
  files: string[];
}

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The repo-relative src/ or packages/ file a dev server request loads, else
 * null: other hosts, query strings, virtual modules (/@id, /@vite, ...) and
 * node_modules are dropped; /@fs/<abs> and root-relative paths resolve.
 */
export function fileOfRequest(url: string, root: string = ROOT): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!LOCAL.has(u.hostname) || !u.protocol.startsWith('http')) return null;
  let p: string;
  try {
    p = decodeURIComponent(u.pathname);
  } catch {
    return null;
  }
  let abs: string;
  if (p.startsWith('/@fs/')) abs = p.slice('/@fs'.length);
  else if (p.startsWith('/@') || p.startsWith('/__')) return null;
  else abs = path.join(root, HARNESS, p);
  const rel = path.relative(root, abs).split(path.sep).join('/');
  if (rel.startsWith('..') || rel.includes('node_modules/')) return null;
  return rel.startsWith('src/') || rel.startsWith('packages/') ? rel : null;
}

/** A fragment's file name (one per screen per project). */
export const fragmentPath = (project: string, screen: string): string =>
  `${FRAGMENT_DIR}/${project.replace(/[^\w.-]/g, '_')}/${screen.replace(/[^\w.-]/g, '_')}.json`;

/** Writes one screen's fragment (sync, a few hundred bytes). */
export function writeFragment(f: Fragment, root: string = ROOT): void {
  const out = path.join(root, fragmentPath(f.project, f.screen));
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify({ ...f, files: [...new Set(f.files)].sort() })}\n`);
}

/** The union of every fragment's files per screen: sorted keys, sorted arrays. */
export function mergeFragments(fragments: readonly Fragment[]): ScreenMap {
  const acc = new Map<string, Set<string>>();
  for (const f of fragments) {
    const set = acc.get(f.screen) ?? new Set<string>();
    f.files.forEach((x) => set.add(x));
    acc.set(f.screen, set);
  }
  const out: ScreenMap = {};
  for (const k of [...acc.keys()].sort()) out[k] = [...(acc.get(k) ?? [])].sort();
  return out;
}

/** The committed form: two-space JSON, keys and arrays sorted, one trailing newline. */
export function serializeMap(map: Readonly<ScreenMap>): string {
  const sorted: ScreenMap = {};
  for (const k of Object.keys(map).sort()) sorted[k] = [...new Set(map[k] ?? [])].sort();
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

/** A map from its text, else null (not an object of string arrays). */
export function parseMap(text: string): ScreenMap | null {
  try {
    const v: unknown = JSON.parse(text);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
    const out: ScreenMap = {};
    for (const [k, files] of Object.entries(v as Record<string, unknown>)) {
      if (!Array.isArray(files) || !files.every((x) => typeof x === 'string')) return null;
      out[k] = files as string[];
    }
    return out;
  } catch {
    return null;
  }
}

/** Every fragment under the given folders (recursive). */
export function readFragments(dirs: readonly string[]): Fragment[] {
  const out: Fragment[] = [];
  const walk = (d: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const e of entries.sort()) {
      const p = path.join(d, e);
      if (e.endsWith('.json')) {
        const v = JSON.parse(readFileSync(p, 'utf8')) as Partial<Fragment>;
        if (typeof v.screen === 'string' && Array.isArray(v.files)) {
          out.push({ screen: v.screen, project: String(v.project ?? ''), files: v.files });
        }
      } else walk(p);
    }
  };
  dirs.forEach(walk);
  return out;
}

function main(argv: string[]): void {
  if (argv[0] !== 'merge') throw new Error('usage: visual-map.ts merge <dir>... --out <file>');
  const i = argv.indexOf('--out');
  const outFile = i >= 0 ? argv[i + 1] : undefined;
  if (outFile === undefined) throw new Error('--out <file> is required');
  const dirs = argv.slice(1).filter((_, k) => k + 1 !== i && k + 1 !== i + 1);
  const fragments = readFragments(dirs);
  const map = mergeFragments(fragments);
  writeFileSync(outFile, serializeMap(map));
  process.stdout.write(
    `visual-map: ${fragments.length} fragments, ${Object.keys(map).length} screens -> ${outFile}\n`,
  );
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2));
}
