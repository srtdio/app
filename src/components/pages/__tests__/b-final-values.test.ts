// Value lock (Layout rules L1, L9): the pages draw spacing from the 4px scale,
// type from the Text roles and keys from the data. Pure source scan, no render.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const FILES = sourceFiles(ROOT).map((path) => ({
  rel: relative(ROOT, path).split(sep).join('/'),
  src: readFileSync(path, 'utf8'),
}));

function offenders(pattern: RegExp): string[] {
  const out: string[] = [];
  for (const { rel, src } of FILES) {
    src.split('\n').forEach((line, n) => {
      if (pattern.test(line)) out.push(`${rel}:${n + 1}`);
    });
  }
  return out;
}

describe('pages: value lock', () => {
  it('scans the pages', () => {
    expect(FILES.length).toBeGreaterThan(50);
  });

  it('no leading-* or tracking-* at a call site (Text roles and SECTION_LABEL own them)', () => {
    expect(
      offenders(/["'`\s:](leading|tracking)-(none|tight|snug|normal|relaxed|loose|\d|\[)/),
    ).toEqual([]);
  });

  it('no half steps (1.5, 2.5, 3.5) on spacing or size classes', () => {
    expect(
      offenders(
        /["'`\s:]-?(p[trblxyse]?|m[trblxyse]?|gap(-[xy])?|space-[xy]|top|left|right|bottom|inset(-[xy])?|h|w|size)-(1|2|3)\.5\b/,
      ),
    ).toEqual([]);
  });

  it('44 tap floors use the scale (min-h-11 / min-w-11), never [44px]', () => {
    expect(offenders(/min-[hw]-\[44px\]/)).toEqual([]);
  });

  it('list keys come from the data, never the array index', () => {
    expect(offenders(/key=\{(i|index|idx)\}/)).toEqual([]);
  });

  it('no z-[N]: the 60 layer is the only one left and is listed for a named token', () => {
    const files = new Set(offenders(/["'`\s:]z-\[/).map((at) => at.split(':')[0]));
    expect([...files].sort()).toEqual([
      'create/FilePromptSheet.tsx',
      'pipeline/PipelineDateRangeCalendar.tsx',
    ]);
  });
});
