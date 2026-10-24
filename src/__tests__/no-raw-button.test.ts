import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Every control renders through Button, IconButton, Chip, PressableRow,
// Backdrop or DropZone from src/components/ui. Only ui/ (the primitives) and
// home/ (the marketing pages) may write a raw <button. test-site/ is a
// staff-only harness outside the app. Test files are skipped: they assert on
// rendered markup, not author it.
const ROOT = fileURLToPath(new URL('../components/', import.meta.url));
const ALLOWED_DIRS = ['ui/', 'home/', 'test-site/'];
const PRIMITIVE_TAG = /<(Button|IconButton|Chip|PressableRow|Backdrop|DropZone)\b/g;
// An important-override token: "!" at the start of a class or after a variant
// prefix (`!px-3`, `hover:!bg-panel`). Not `!==` or a negation in an expression,
// because only string literals inside the className are read.
const BANG_CLASS = /(?:^|[\s:])!(?=[a-z[-])/;

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsxFiles(path);
    return name.endsWith('.tsx') ? [path] : [];
  });
}

function sourceFiles(): string[] {
  return tsxFiles(ROOT)
    .map((path) => relative(ROOT, path).split(sep).join('/'))
    .filter((rel) => !/\.test\.tsx$/.test(rel));
}

/** The opening tag starting at `start`, up to its closing `>` outside any `{...}`. */
function openingTag(src: string, start: number): string {
  let depth = 0;
  for (let i = start; i < src.length; i += 1) {
    const c = src[i];
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    else if (c === '>' && depth === 0) return src.slice(start, i);
  }
  return src.slice(start);
}

/** "file:line Tag" for each primitive whose className literals carry a "!" token. */
export function importantOverrides(rel: string, src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(PRIMITIVE_TAG)) {
    const tag = openingTag(src, m.index);
    const at = tag.indexOf('className=');
    if (at < 0) continue;
    const literals = tag.slice(at).match(/'[^']*'|"[^"]*"|`[^`]*`/g) ?? [];
    if (literals.some((lit) => BANG_CLASS.test(lit.slice(1, -1)))) {
      const line = src.slice(0, m.index).split('\n').length;
      out.push(`${rel}:${line} ${m[1]}`);
    }
  }
  return out;
}

describe('no raw <button> outside the ui primitives', () => {
  it('src/components/**/*.tsx has no "<button" outside ui/ and home/', () => {
    const offenders = sourceFiles()
      .filter((rel) => !ALLOWED_DIRS.some((d) => rel.startsWith(d)))
      .map((rel) => ({
        rel,
        count: readFileSync(join(ROOT, rel), 'utf8').split('<button').length - 1,
      }))
      .filter(({ count }) => count > 0)
      .map(({ rel, count }) => `${rel} (${count})`);
    expect(offenders).toEqual([]);
  });

  it('no className with a "!" override on Button, IconButton, Chip, PressableRow, Backdrop or DropZone', () => {
    const offenders = sourceFiles().flatMap((rel) =>
      importantOverrides(rel, readFileSync(join(ROOT, rel), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('the override scan catches a "!" token and ignores expression negation', () => {
    expect(importantOverrides('a.tsx', '<Button className="!px-3 flex">Go</Button>')).toEqual([
      'a.tsx:1 Button',
    ]);
    expect(
      importantOverrides('b.tsx', "<PressableRow className={cn('flex', on && 'hover:!bg-panel')}>"),
    ).toEqual(['b.tsx:1 PressableRow']);
    expect(
      importantOverrides('c.tsx', "<Chip disabled={!ok} className={cn('shrink-0', !ok && 'x')} />"),
    ).toEqual([]);
  });
});
