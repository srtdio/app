// A source-level check: no page drops a kept session read when it unmounts. A
// tab return paints the kept view at once (src/lib/session-read.ts,
// src/lib/kept-view.ts); a useEffect cleanup that drops the read makes the
// next visit read the server again behind a skeleton. Comments are stripped
// first. No page is exempt.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const PAGES = join(__dirname, '..', 'components', 'pages');
const DROP = /\bdrop\w*Reads\b|\bdropPipelinePosts\b|\bdropAllPipelinePosts\b/;
// A cleanup arrow: `return () =>` inside an effect, or an effect that is
// itself `() => () =>`.
const CLEANUP = /\breturn\s*\(\s*\)\s*=>|\buseEffect\(\s*\(\s*\)\s*=>\s*\(\s*\)\s*=>/g;

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return pages(path);
    return name.endsWith('.tsx') && !name.endsWith('.test.tsx') ? [path] : [];
  });
}

function withoutComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * The cleanup's body from `start`: a block body up to its balanced closing
 * brace, or an expression body up to the end of its statement (a `;`, a `,` or
 * newline at depth 0, or the bracket that closes its enclosing call or block).
 */
function cleanupBody(code: string, start: number): string {
  let i = start;
  while (i < code.length && /\s/.test(code[i] ?? '')) i += 1;
  const block = code[i] === '{';
  let depth = 0;
  for (let j = i; j < code.length; j += 1) {
    const ch = code[j];
    if (ch === '{' || ch === '(' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ')' || ch === ']') {
      depth -= 1;
      if (depth === 0 && block) return code.slice(i, j + 1);
      if (depth < 0) return code.slice(i, j);
    } else if (!block && depth === 0 && (ch === ';' || ch === ',' || ch === '\n')) {
      return code.slice(i, j);
    }
  }
  return code.slice(i);
}

/** True when any effect cleanup in `code` drops a kept read. */
function cleanupDropsReads(code: string): boolean {
  const source = withoutComments(code);
  for (const match of source.matchAll(CLEANUP)) {
    const body = cleanupBody(source, (match.index ?? 0) + match[0].length);
    if (DROP.test(body)) return true;
  }
  return false;
}

describe('kept views survive page leave', () => {
  it('the matcher flags a dropping cleanup and passes a plain one', () => {
    expect(cleanupDropsReads('useEffect(() => { return () => dropAssetsReads(u, w); }, [])')).toBe(
      true,
    );
    expect(
      cleanupDropsReads(
        'useEffect(() => {\n  return () => {\n    if (ok) dropPipelinePosts(u, w);\n  };\n}, []);',
      ),
    ).toBe(true);
    expect(
      cleanupDropsReads('useEffect(\n  () => () => {\n    dropBriefsReads(u, w);\n  },\n  [],\n);'),
    ).toBe(true);
    expect(cleanupDropsReads('return () => { cancelled = true; }')).toBe(false);
    expect(
      cleanupDropsReads(
        'useEffect(() => { return () => { live = false; }; }, []);\ndropAssetsReads(u, w);',
      ),
    ).toBe(false);
  });

  it('no page useEffect cleanup drops a session read', () => {
    const offenders = pages(PAGES)
      .filter((path) => cleanupDropsReads(readFileSync(path, 'utf8')))
      .map((path) => relative(PAGES, path));
    expect(offenders).toEqual([]);
  });
});
