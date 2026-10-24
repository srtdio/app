import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Every control renders through Button, IconButton, Chip or PressableRow from
// src/components/ui. Only ui/ (the primitives) and home/ (the marketing pages)
// may write a raw <button. test-site/ is a staff-only harness outside the app.
// Test files are skipped: they assert on rendered markup, not author it.
const ROOT = fileURLToPath(new URL('../components/', import.meta.url));
const ALLOWED_DIRS = ['ui/', 'home/', 'test-site/'];

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsxFiles(path);
    return name.endsWith('.tsx') ? [path] : [];
  });
}

describe('no raw <button> outside the ui primitives', () => {
  it('src/components/**/*.tsx has no "<button" outside ui/ and home/', () => {
    const offenders = tsxFiles(ROOT)
      .map((path) => relative(ROOT, path).split(sep).join('/'))
      .filter((rel) => !ALLOWED_DIRS.some((d) => rel.startsWith(d)))
      .filter((rel) => !/\.test\.tsx$/.test(rel))
      .filter((rel) => readFileSync(join(ROOT, rel), 'utf8').includes('<button'));
    expect(offenders).toEqual([]);
  });
});
