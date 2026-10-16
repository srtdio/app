// A source-level check: no "(ex-member)" or "Unknown member" string literal is
// left in the app (comments are stripped first). A person who is not a current
// member reads "Former member" through the shared name helper. No file is exempt.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const BANNED = /(['"`])[^'"`\n]*(?:\(ex-member\)|Unknown member)[^'"`\n]*\1/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

function withoutComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('no placeholder member names in src', () => {
  it('no "(ex-member)" or "Unknown member" literal renders anywhere', () => {
    const offenders = sources(ROOT)
      .map((path) => relative(ROOT, path))
      .filter((rel) => BANNED.test(withoutComments(readFileSync(join(ROOT, rel), 'utf8'))));
    expect(offenders).toEqual([]);
  });
});
