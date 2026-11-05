import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Timing (docs/motion.md, Waits). The Undo strip (UNDO_MS) and every toast
// (TOAST_MS, ERROR_TOAST_MS) count down on the one pausable timer
// (src/lib/pausable-timer.ts), so hover, focus and touch hold them; no file
// runs one of those windows on a raw setTimeout. Busy placeholders (BoxSkeleton
// and the image spinners in the lightboxes and file viewer) show through the
// one useDelayedBusy hook, so a fast load never flashes them. Every hit prints
// as file:line.
const SRC = fileURLToPath(new URL('../', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

const FILES = sources(SRC)
  .map((path) => relative(SRC, path).split(sep).join('/'))
  .filter((rel) => !rel.startsWith('server/'))
  .filter((rel) => !/\.test\.tsx?$/.test(rel) && !rel.includes('__tests__/'))
  .map((rel) => ({ rel, src: readFileSync(join(SRC, rel), 'utf8') }));

function read(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

function lineOf(src: string, index: number): number {
  return src.slice(0, index).split('\n').length;
}

/** The text inside the parentheses that open at `open` (balanced). */
function callArgs(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i];
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return src.slice(open + 1);
}

const BASE = ['UNDO_MS', 'TOAST_MS', 'ERROR_TOAST_MS'];
/** The timed windows plus every local alias of one (`const UNDO_WINDOW_MS = UNDO_MS`). */
const WINDOWS: readonly string[] = (() => {
  const names = new Set(BASE);
  for (const { src } of FILES) {
    for (const m of src.matchAll(/\bconst\s+(\w+)\s*=\s*(\w+)\s*;/g)) {
      if (names.has(m[2] ?? '')) names.add(m[1] ?? '');
    }
  }
  return [...names];
})();
const WINDOW_RE = new RegExp(`\\b(${WINDOWS.join('|')})\\b`);

const IMPORTS_WINDOW =
  /import\s*\{[^}]*\b(UNDO_MS|TOAST_MS|ERROR_TOAST_MS)\b[^}]*\}\s*from\s*'@\/(lib\/undo|components\/ui\/toast\/ToastProvider)'/;

describe('timing rules: the Undo and toast windows run on the pausable timer', () => {
  it('the scan sees the window and its aliases', () => {
    expect(WINDOWS).toEqual(expect.arrayContaining(['UNDO_MS', 'TOAST_MS', 'UNDO_WINDOW_MS']));
  });

  it('no raw setTimeout or setInterval runs UNDO_MS, TOAST_MS or an alias', () => {
    const offenders: string[] = [];
    for (const { rel, src } of FILES) {
      for (const m of src.matchAll(/\b(?:window\.)?(setTimeout|setInterval)\s*\(/g)) {
        const at = m.index ?? 0;
        const args = callArgs(src, at + m[0].length - 1);
        if (WINDOW_RE.test(args)) offenders.push(`${rel}:${lineOf(src, at)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every file importing UNDO_MS or TOAST_MS uses the pausable timer or hands it to the toast store', () => {
    const files = FILES.filter(({ src }) => IMPORTS_WINDOW.test(src));
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const { rel, src } of files) {
      const pausable = /from '@\/lib\/pausable-timer'/.test(src);
      // `durationMs: <window>` goes to toast.show(), which counts on the pausable timer.
      const handed = new RegExp(`durationMs:\\s*(${WINDOWS.join('|')})\\b`).test(src);
      // Only re-exports an alias (`export const DRAFT_UNDO_MS = UNDO_MS`).
      const alias = `export const \\w+\\s*=\\s*(${WINDOWS.join('|')})\\s*;`;
      const aliasOnly = new RegExp(alias).test(src);
      if (!pausable && !handed && !aliasOnly) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('the toast store owns its countdowns on createPausableTimer, never a raw setTimeout', () => {
    const src = read('components/ui/toast/ToastProvider.tsx');
    expect(src).toMatch(
      /import \{[^}]*\bcreatePausableTimer\b[^}]*\} from '@\/lib\/pausable-timer'/,
    );
    expect(src).toMatch(/export const TOAST_MS = 4000;/);
    expect(src).toMatch(/export const ERROR_TOAST_MS = 8000;/);
    expect(src).not.toMatch(/\bsetTimeout\s*\(/);
    // Cards and the strip both hold on hover, focus and touch.
    expect(src).toMatch(/\bholdHandlers\(/);
    expect(src).toMatch(/onHold=\{ctx\.hold\}/);
  });

  it('the Undo strip holds its window on hover, focus and touch', () => {
    const src = read('components/ui/toast/UndoStrip.tsx');
    expect(src).toMatch(/from '@\/lib\/pausable-timer'/);
    for (const handler of ['onPointerEnter', 'onPointerLeave', 'onFocus', 'onBlur']) {
      expect(src, handler).toMatch(new RegExp(`${handler}=\\{holds\\.${handler}\\}`));
    }
    expect(src).toMatch(/holds\.onPointerDown\(\)/);
    expect(read('lib/undo.ts')).toMatch(/export const UNDO_MS = 4000;/);
  });
});

describe('timing rules: busy placeholders show through useDelayedBusy', () => {
  it('BoxSkeleton uses useDelayedBusy with SKELETON_BUSY', () => {
    const react = read('lib/motion/react.tsx');
    const start = react.indexOf('export function BoxSkeleton(');
    expect(start).toBeGreaterThan(-1);
    const end = react.indexOf('\n}\n', start);
    const body = react.slice(start, end);
    expect(body).toMatch(/useDelayedBusy\([^)]*SKELETON_BUSY\)/);
  });

  const SPINNER_FILES = [
    'components/ui/ImageLightbox.tsx',
    'components/pages/assets/AssetLightbox.tsx',
    'components/pages/pcs/PostLightbox.tsx',
    'components/ui/FileViewer.tsx',
  ];

  it.each(SPINNER_FILES)('%s shows its spinner through useDelayedBusy (SPINNER_BUSY)', (rel) => {
    const src = read(rel);
    expect(src).toMatch(/from '@\/lib\/useDelayedBusy'/);
    expect(src).toMatch(/useDelayedBusy\([^)]*SPINNER_BUSY\)/);
    // Every mv-spin in the file is gated by the hook's result.
    const spins = src.match(/\bmv-spin\b/g)?.length ?? 0;
    const gated = src.match(/!(show|showSpinner) && 'invisible'/g)?.length ?? 0;
    expect(gated).toBeGreaterThanOrEqual(spins);
  });

  it('the shared ceilings: spinners 200/400, skeleton 150/300', () => {
    const src = read('lib/useDelayedBusy.ts');
    expect(src).toMatch(/SPINNER_BUSY = \{ delay: 200, minVisible: 400 \}/);
    expect(src).toMatch(/SKELETON_BUSY = \{ delay: 150, minVisible: 300 \}/);
  });
});
