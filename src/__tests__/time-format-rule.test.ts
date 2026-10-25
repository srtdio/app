import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Dates and times come from src/lib/time.ts only (CLAUDE.md, Design rules).
const SRC = fileURLToPath(new URL('../', import.meta.url));
const ROOTS = ['components/', 'lib/'];
const EXEMPT_FILES = new Set(['lib/time.ts', 'components/support/book-call-slots.ts']);
const EXEMPT_DIRS = ['components/home/', 'components/test-site/', 'server/'];
const BANNED = /toLocaleTimeString|toLocaleDateString|Intl\.DateTimeFormat/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('time format rule', () => {
  it('no toLocale*/Intl.DateTimeFormat outside src/lib/time.ts and the exempt files', () => {
    const offenders = ROOTS.flatMap((root) => sourceFiles(join(SRC, root)))
      .map((path) => relative(SRC, path).split(sep).join('/'))
      .filter((rel) => !EXEMPT_FILES.has(rel) && !EXEMPT_DIRS.some((d) => rel.startsWith(d)))
      .filter((rel) => BANNED.test(readFileSync(join(SRC, rel), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
