import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Errors rule from CLAUDE.md (Design rules): "Couldn't {action}. {reason}". The
// reason is read off the error by errorCopy (src/lib/error-copy.ts), so a
// refusal shows its real reason; "Try again." is the reason only when nothing
// better is known, and it lives in REASON_COPY alone. Scans the visible text
// (string literals, template literals, JSX text; comments stripped) of every
// source file in src/components and src/lib, tests excluded.
const SRC = fileURLToPath(new URL('../', import.meta.url));
const SCANNED = ['components', 'lib'];
const ERROR_COPY = 'lib/error-copy.ts';

function isTestPath(rel: string): boolean {
  return /\.test\.tsx?$/.test(rel) || rel.split('/').includes('__tests__');
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

const FILES = SCANNED.flatMap((dir) => sourceFiles(join(SRC, dir)))
  .map((path) => relative(SRC, path).split(sep).join('/'))
  .filter((rel) => rel !== ERROR_COPY && !isTestPath(rel))
  .map((rel) => ({ rel, source: readFileSync(join(SRC, rel), 'utf8') }));

/** Visible text only: string literals, template literals and JSX text, minus comments. */
function visibleText(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
  const out: string[] = [];
  for (const m of code.matchAll(
    /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g,
  )) {
    out.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  for (const m of code.matchAll(/>([^<>{}]+)</g)) out.push(m[1] ?? '');
  return out;
}

const TRY_AGAIN = /\bTry again\./;

describe('error copy rules', () => {
  it('scans a real tree', () => {
    expect(FILES.length).toBeGreaterThan(100);
    expect(FILES.some((f) => f.rel === 'lib/asset-upload.ts')).toBe(true);
  });

  it('no literal "Try again." outside src/lib/error-copy.ts: failures go through errorCopy', () => {
    const offenders = FILES.flatMap(({ rel, source }) =>
      visibleText(source)
        .filter((text) => TRY_AGAIN.test(text))
        .map((text) => `${rel}: ${text.trim()}`),
    );
    expect(offenders).toEqual([]);
  });

  it('the one "Try again." is the retry reason in error-copy.ts', () => {
    const source = readFileSync(join(SRC, ERROR_COPY), 'utf8');
    expect(visibleText(source).filter((text) => TRY_AGAIN.test(text))).toEqual([
      'Try again.',
      'Try again.',
    ]);
  });

  it('never "Try again" as a button label: buttons say Retry', () => {
    const offenders = FILES.flatMap(({ rel, source }) => {
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '');
      const hits = [
        ...code.matchAll(/<(?:Button|button)\b[^>]*>\s*Try again\s*<\/(?:Button|button)>/g),
        ...code.matchAll(/label:\s*['"]Try again['"]/g),
      ];
      return hits.map((m) => `${rel}: ${m[0].replace(/\s+/g, ' ')}`);
    });
    expect(offenders).toEqual([]);
  });
});
