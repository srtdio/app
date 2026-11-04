import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// FRONTEND-N lock: the DOM mutation guard (browser translation rewrites text
// nodes React owns) must be installed before React creates or hydrates a root.
// Reads src/main.tsx as text; it never imports or runs it.
const source = readFileSync(fileURLToPath(new URL('./main.tsx', import.meta.url)), 'utf8');

/** The source with comments blanked out, so a commented-out call never counts. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('src/main.tsx boot order (FRONTEND-N)', () => {
  it('imports and calls installDomMutationGuard()', () => {
    expect(code).toMatch(
      /import\s*\{[^}]*\binstallDomMutationGuard\b[^}]*\}\s*from\s*'@\/lib\/dom-mutation-guard'/,
    );
    expect(code).toMatch(/\binstallDomMutationGuard\(\s*\)/);
  });

  it('calls it before any createRoot or hydrateRoot call', () => {
    const guard = code.search(/\binstallDomMutationGuard\(\s*\)/);
    const roots = [...code.matchAll(/\b(createRoot|hydrateRoot)\s*\(/g)].map((m) => m.index);
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(roots.length).toBeGreaterThan(0);
    for (const at of roots) expect(at).toBeGreaterThan(guard);
  });

  it('calls it at module top level, not inside a function that may run later', () => {
    const line = code.split('\n').find((l) => /\binstallDomMutationGuard\(\s*\)/.test(l));
    expect(line).toBeDefined();
    expect(line?.startsWith('installDomMutationGuard(')).toBe(true);
  });
});

describe('src/main.tsx font preload', () => {
  it('preloads Inter 400/500/600 latin woff2 via ?url imports', () => {
    for (const weight of ['400', '500', '600']) {
      expect(code).toContain(`@fontsource/inter/files/inter-latin-${weight}-normal.woff2?url'`);
    }
    expect(code).toMatch(/link\.rel = 'preload'/);
    expect(code).toMatch(/link\.as = 'font'/);
    expect(code).toMatch(/link\.type = 'font\/woff2'/);
    expect(code).toMatch(/link\.crossOrigin = 'anonymous'/);
  });

  it('runs at module top level before any root is created, with no await', () => {
    const call = code.search(/^preloadFonts\(/m);
    expect(call).toBeGreaterThanOrEqual(0);
    const roots = [...code.matchAll(/\b(createRoot|hydrateRoot)\s*\(/g)].map((m) => m.index);
    for (const at of roots) expect(at).toBeGreaterThan(call);
    const fn = code.slice(code.indexOf('function preloadFonts'), call);
    expect(fn).not.toMatch(/\bawait\b|\bfetch\b/);
  });
});
