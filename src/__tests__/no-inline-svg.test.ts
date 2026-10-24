import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Icons come from src/components/ui/icons.tsx only. These files draw
// non-icon graphics (rings, rails, marks, illustrations) and may keep <svg.
const ROOT = fileURLToPath(new URL('../components/', import.meta.url));
const ALLOWED = new Set([
  'ui/icons.tsx',
  'ui/format-icon.tsx',
  'ui/PlatformMark.tsx',
  'chat/UploadRing.tsx',
  'chat/ThreadRail.tsx',
  'chat/tasks/TaskGlyph.tsx',
  'induction/GuideParts.tsx',
]);
const ALLOWED_DIRS = ['home/'];

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsxFiles(path);
    return name.endsWith('.tsx') ? [path] : [];
  });
}

describe('no inline svg outside the icon set', () => {
  it('src/components/**/*.tsx has no <svg outside the allowed files', () => {
    const offenders = tsxFiles(ROOT)
      .map((path) => relative(ROOT, path).split(sep).join('/'))
      .filter((rel) => !ALLOWED.has(rel) && !ALLOWED_DIRS.some((d) => rel.startsWith(d)))
      .filter((rel) => !/\.test\.tsx$/.test(rel))
      .filter((rel) => readFileSync(join(ROOT, rel), 'utf8').includes('<svg'));
    expect(offenders).toEqual([]);
  });
});
