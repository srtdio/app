import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Composer rows (approved 8 Nov 2026): a writing box's row keys are a 36
// circle on a 44 tall hit, set 36 apart horizontally. That 36 wide hit is the
// one exception to the 44x44 rule, and it lives only in the composer row
// parts: ui/WritingBox (RowKey, RowSend) and chat/ComposerTray's compact +.
// Anywhere else a control keeps 44x44. Test files are skipped.
const ROOT = fileURLToPath(new URL('../components/', import.meta.url));

/** The only files that may draw a 36 wide hit (w-9 on a 44 tall control). */
export const ROW_KEY_FILES: readonly string[] = ['ui/WritingBox.tsx', 'chat/ComposerTray.tsx'];

// A 44 tall control 36 wide: "h-11 ... w-9" in one class string, or the
// min-w-9 that lets a 44 Button shrink to 36.
const NARROW_HIT = /(?:\bh-11\b[^'"`]*\bw-9\b|\bw-9\b[^'"`]*\bh-11\b|\bmin-w-9\b)/;

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsxFiles(path);
    return name.endsWith('.tsx') && !name.endsWith('.test.tsx') ? [path] : [];
  });
}

/** "file:line" for each narrow-hit class string outside the composer row parts. */
export function narrowHits(rel: string, src: string): string[] {
  if (ROW_KEY_FILES.includes(rel)) return [];
  const out: string[] = [];
  src.split('\n').forEach((line, i) => {
    if (NARROW_HIT.test(line)) out.push(`${rel}:${i + 1}`);
  });
  return out;
}

describe('composer row keys: the 36 exception stays in composer rows', () => {
  it('no component outside ui/WritingBox and chat/ComposerTray draws a 36 wide hit', () => {
    const offenders = tsxFiles(ROOT).flatMap((path) =>
      narrowHits(relative(ROOT, path).split(sep).join('/'), readFileSync(path, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('the row parts keep the 44 tall hit', () => {
    const src = readFileSync(join(ROOT, 'ui/WritingBox.tsx'), 'utf8');
    expect(src).toMatch(/inline-flex h-11 w-9 shrink-0/);
    expect(src).toMatch(/h-9 w-9/);
  });

  it('narrowHits flags a 36 wide hit elsewhere and passes the row parts', () => {
    expect(narrowHits('pages/X.tsx', "className='h-11 w-9'")).toEqual(['pages/X.tsx:1']);
    expect(narrowHits('ui/WritingBox.tsx', "className='h-11 w-9'")).toEqual([]);
  });

  it('CLAUDE.md records the exception', () => {
    const doc = readFileSync(fileURLToPath(new URL('../../CLAUDE.md', import.meta.url)), 'utf8');
    expect(doc).toContain('composer-row-keys.test.ts');
  });
});
