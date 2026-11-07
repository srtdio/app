import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// No X anywhere (design lock, D4). Back "<" leaves; the stop square cancels a
// send; the bin removes; "Clear" clears or dismisses. No cross icon and no
// cross glyph may appear in any app source file under src. Test files are
// skipped: they assert on rendered markup, not author it. Allowlist: none.
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ICONS = fileURLToPath(new URL('../components/ui/icons.tsx', import.meta.url));

/** The cross icon names and glyphs that may not appear in app source. */
const BANNED: { name: string; re: RegExp }[] = [
  { name: 'IconX', re: /\bIconX\b/ },
  { name: 'XMarkIcon', re: /XMarkIcon/ },
  { name: 'XCircleIcon', re: /XCircleIcon/ },
  { name: '×', re: /×/ },
  { name: '✕', re: /✕/ },
  { name: '✖', re: /✖/ },
  { name: '⨯', re: /⨯/ },
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === '__tests__' || name === 'node_modules' ? [] : sourceFiles(path);
    }
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

/** "file:line name" for each banned cross in a source text. Pure. */
export function crossUses(rel: string, src: string): string[] {
  const out: string[] = [];
  src.split('\n').forEach((line, i) => {
    for (const { name, re } of BANNED) {
      if (re.test(line)) out.push(`${rel}:${i + 1} ${name}`);
    }
  });
  return out;
}

describe('no cross anywhere', () => {
  it('no non-test file under src uses IconX, XMarkIcon, XCircleIcon or a cross glyph', () => {
    const offenders = sourceFiles(ROOT).flatMap((path) =>
      crossUses(relative(ROOT, path).split(sep).join('/'), readFileSync(path, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('icons.tsx exports no IconX', () => {
    const src = readFileSync(ICONS, 'utf8');
    expect(src).not.toMatch(/export\s+(function|const)\s+IconX\b/);
  });

  it('crossUses flags each banned form and passes clean text', () => {
    expect(crossUses('a.tsx', 'import { IconX } from x')).toEqual(['a.tsx:1 IconX']);
    expect(crossUses('a.tsx', 'ok\n<span>×</span>')).toEqual(['a.tsx:2 ×']);
    expect(crossUses('a.tsx', "'✕' '✖' '⨯'")).toEqual(['a.tsx:1 ✕', 'a.tsx:1 ✖', 'a.tsx:1 ⨯']);
    expect(crossUses('a.tsx', 'XMarkIcon XCircleIcon')).toEqual([
      'a.tsx:1 XMarkIcon',
      'a.tsx:1 XCircleIcon',
    ]);
    expect(crossUses('a.tsx', 'IconXRay IconTrash Clear')).toEqual([]);
  });
});
