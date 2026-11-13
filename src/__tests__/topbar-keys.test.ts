import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Top bar keys (decided 10 Nov 2026): below md, Search, sort, "+" and the
// avatar are 36 wide x 44 tall hit strips, touching (gap 0), so they sit 36
// apart centre to centre. That 36 strip (the named width w-topbar-key) is the
// second written exception to the 44x44 rule, beside the composer row keys
// (composer-row-keys.test.ts). It lives only in the top bar parts:
// shell/Topbar (the slots, Search, the avatar) and shell/topbar-actions (the
// "+"). Test files are skipped.
const ROOT = fileURLToPath(new URL('../components/', import.meta.url));

/** The only files that may draw a top bar key strip. */
export const TOPBAR_KEY_FILES: readonly string[] = ['shell/Topbar.tsx', 'shell/topbar-actions.tsx'];

const KEY_STRIP = /\bw-topbar-key\b/;

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsxFiles(path);
    return name.endsWith('.tsx') && !name.endsWith('.test.tsx') ? [path] : [];
  });
}

/** "file:line" for each key strip class outside the top bar parts. */
export function keyStrips(rel: string, src: string): string[] {
  if (TOPBAR_KEY_FILES.includes(rel)) return [];
  const out: string[] = [];
  src.split('\n').forEach((line, i) => {
    if (KEY_STRIP.test(line)) out.push(`${rel}:${i + 1}`);
  });
  return out;
}

const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

describe('top bar keys: the 36 strip stays in the top bar, below md only', () => {
  it('no component outside shell/Topbar and shell/topbar-actions draws a key strip', () => {
    const offenders = tsxFiles(ROOT).flatMap((path) =>
      keyStrips(relative(ROOT, path).split(sep).join('/'), read(relative(ROOT, path))),
    );
    expect(offenders).toEqual([]);
  });

  it('the strips are 44 tall, gap 0 below md, gap-1 and 44 boxes from md', () => {
    const src = read('shell/Topbar.tsx');
    // The cluster: no gap below md, gap-1 from md.
    expect(src).toContain('className="ml-auto flex items-center md:gap-1"');
    // Search and the avatar: 36 only below md (their IconButton stays 44 tall).
    expect(src).toContain("export const TOPBAR_KEY = 'max-md:w-topbar-key max-md:min-w-0';");
    expect(src).toMatch(/label="Search"\s+className=\{cn\('md:hidden', TOPBAR_KEY\)\}/);
    expect(src).toMatch(
      /label="Account menu"\s+className=\{cn\(TOPBAR_KEY, 'max-md:justify-end'\)\}/,
    );
    // The slots: a 44 tall strip, 36 below md; sort 44 and primary 112 from md.
    expect(src).toContain("'inline-flex h-11 w-topbar-key shrink-0 items-center justify-center'");
    expect(src).toContain("'md:w-auto md:min-w-11 max-md:[&_button]:w-topbar-key");
    expect(src).toContain(": 'md:w-28'");
  });

  it('the "+" hit is 36 x 44 below md and 112 x 44 from md', () => {
    const src = read('shell/topbar-actions.tsx');
    expect(src).toMatch(
      /TOPBAR_PLUS_HIT =\s+'group shrink-0 px-0 text-fg w-topbar-key min-w-0 md:w-28/,
    );
    // Button keeps its 44 tall base (h-11 min-h-11); the "+" never sets a height.
    expect(src).not.toMatch(/TOPBAR_PLUS_HIT =[^;]*\bh-(?!11)\d/);
  });

  it('keyStrips flags a key strip elsewhere and passes the top bar parts', () => {
    expect(keyStrips('pages/X.tsx', "className='h-11 w-topbar-key'")).toEqual(['pages/X.tsx:1']);
    expect(keyStrips('shell/Topbar.tsx', "className='h-11 w-topbar-key'")).toEqual([]);
  });

  it('one top bar on every tab: no Activity pair, no short name (10 Nov 2026)', () => {
    const bar = read('shell/Topbar.tsx');
    const actions = read('shell/topbar-actions.tsx');
    expect(bar).not.toMatch(/\bpair\b|data-topbar-pair|shortWorkspaceName|workspace-short/);
    expect(actions).not.toMatch(/\bpair\?:/);
    // Activity publishes no sort and no "+": both slots stay empty boxes.
    const activity = read('pages/NotificationsPage.tsx');
    expect(activity).not.toMatch(/\buseTopbarActions\(/);
    // Catch up lives on each tab (13 Nov 2026): no lead row on Activity.
    expect(activity).not.toContain('lead={leadRow}');
  });

  it('CLAUDE.md records the exception', () => {
    const doc = readFileSync(fileURLToPath(new URL('../../CLAUDE.md', import.meta.url)), 'utf8');
    expect(doc).toContain('topbar-keys.test.ts');
  });
});
