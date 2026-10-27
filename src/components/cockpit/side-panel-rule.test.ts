import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Design rule (CLAUDE.md): a panel beside the page is ui/SidePanel only, and
// only on laptop (useIsLaptop); phone shows the same content in a Sheet.
const ROOT = fileURLToPath(new URL('../', import.meta.url));

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsxFiles(path);
    return name.endsWith('.tsx') && !name.endsWith('.test.tsx') ? [path] : [];
  });
}

const FILES = tsxFiles(ROOT).map((path) => ({
  rel: relative(ROOT, path).split(sep).join('/'),
  src: readFileSync(path, 'utf8'),
}));

describe('ui rules: one side panel', () => {
  it('no hand-built 380px side panel outside ui/SidePanel.tsx', () => {
    const offenders = FILES.filter(
      ({ rel, src }) => rel !== 'ui/SidePanel.tsx' && /<aside\b[^>]*w-\[380px\]/.test(src),
    ).map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });

  it('every file that renders <SidePanel branches on useIsLaptop and has a Sheet for phone', () => {
    const users = FILES.filter(
      ({ rel, src }) => rel !== 'ui/SidePanel.tsx' && /<SidePanel\b/.test(src),
    );
    expect(users.map((f) => f.rel)).toContain('cockpit/Cockpit.tsx');
    for (const { rel, src } of users) {
      expect(src, rel).toContain('useIsLaptop()');
      expect(src, rel).toMatch(/<Sheet\b/);
    }
  });

  it('SidePanel moves on the X axis only', () => {
    const src = FILES.find((f) => f.rel === 'ui/SidePanel.tsx')?.src ?? '';
    expect(src).toContain('translate-x-full');
    expect(src).not.toMatch(/\btranslate-y-|\brotate-|\bscale-/);
  });
});
