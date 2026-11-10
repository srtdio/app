import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AWKWARD,
  LATER,
  MOMENTS,
  PARTS,
  PENDING,
  STATES,
  type Moment,
} from '../../e2e/gallery/register';

// Parts gallery guard (CLAUDE.md Design and layout, "Gallery"): every ui part
// file is in the register (e2e/gallery/register.ts) or PENDING, never both,
// never neither; every registered moment has a cell on the part's page
// (cell('<id>' in e2e/gallery/<Part>.tsx, read as text, nothing rendered);
// every moment not rendered is skipped with a reason; the gallery spec lists
// exactly the registered parts.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string): string => readFileSync(`${ROOT}${rel}`, 'utf8');

/** The ui part files: every non-test .tsx directly in src/components/ui. */
const UI_FILES = readdirSync(`${ROOT}src/components/ui`)
  .filter((n) => n.endsWith('.tsx') && !/\.test\.tsx$/.test(n))
  .map((n) => `src/components/ui/${n}`)
  .sort();

/** The cell ids a page module declares, in order. */
export function cellIds(src: string): string[] {
  return [...src.matchAll(/\bcell\(\s*'([\w-]+)'/g)].map((m) => m[1] ?? '');
}

describe('gallery register', () => {
  it('the moment lists hold no duplicate', () => {
    expect(new Set(MOMENTS).size).toBe(MOMENTS.length);
    expect(MOMENTS.length).toBe(STATES.length + AWKWARD.length + LATER.length);
  });

  it('every ui part file is registered or PENDING, never both, never neither', () => {
    const registered = PARTS.map((p) => p.file);
    expect(new Set(registered).size, 'a part registered twice').toBe(registered.length);
    expect(new Set(PENDING).size, 'a file pending twice').toBe(PENDING.length);
    const both = registered.filter((f) => PENDING.includes(f));
    expect(both, 'registered and PENDING').toEqual([]);
    const neither = UI_FILES.filter((f) => !registered.includes(f) && !PENDING.includes(f));
    expect(neither, 'ui part files in neither PARTS nor PENDING').toEqual([]);
    const gone = [...registered, ...PENDING].filter((f) => !UI_FILES.includes(f));
    expect(gone, 'register entries with no ui part file').toEqual([]);
  });

  it('each part names its own file', () => {
    for (const p of PARTS) expect(p.file, p.name).toBe(`src/components/ui/${p.name}.tsx`);
  });

  it('every moment is rendered or skipped with a reason, never both', () => {
    for (const p of PARTS) {
      for (const m of MOMENTS) {
        const rendered = p.renders.includes(m);
        const reason = p.skip[m];
        expect(rendered !== (reason !== undefined), `${p.name} ${m}: render xor skip`).toBe(true);
        if (reason !== undefined) expect(reason.trim(), `${p.name} ${m}: skip reason`).not.toBe('');
      }
      for (const m of LATER) expect(p.skip[m], `${p.name} ${m}`).toBe('second gallery PR');
      const unknown = [...p.renders, ...Object.keys(p.skip)].filter(
        (m) => !MOMENTS.includes(m as Moment),
      );
      expect(unknown, `${p.name}: unknown moments`).toEqual([]);
    }
  });

  it('every registered moment has a cell on its page, and every cell is registered', () => {
    for (const p of PARTS) {
      const page = `e2e/gallery/${p.name}.tsx`;
      expect(existsSync(`${ROOT}${page}`), page).toBe(true);
      const ids = cellIds(read(page));
      expect(new Set(ids).size, `${page}: duplicate cell`).toBe(ids.length);
      expect([...ids].sort(), page).toEqual([...p.renders].sort());
    }
  });

  it('the gallery spec and the page map list exactly the registered parts', () => {
    const spec = read('e2e/visual/gallery.spec.ts');
    const screens = [...spec.matchAll(/name: 'gallery-(\w+)', url: '\/gallery\/(\w+)'/g)];
    for (const m of screens) expect(m[1], 'screen name and url agree').toBe(m[2]);
    const names = PARTS.map((p) => p.name).sort();
    expect(screens.map((m) => m[1]).sort()).toEqual(names);
    const pages = read('e2e/gallery/pages.ts');
    const mapped = [...pages.matchAll(/^\s+(\w+): \(\) => import\('\.\/(\w+)'\)/gm)];
    for (const m of mapped) expect(m[1]).toBe(m[2]);
    expect(mapped.map((m) => m[1]).sort()).toEqual(names);
  });
});
