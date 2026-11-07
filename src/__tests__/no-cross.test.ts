import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Exit (design lock, D4; decision F 7 Nov): "<" for anything opening over the
// app; X (IconX) only to cancel an upload (ui/UploadRing), remove an attached
// file (ui/PendingChip) or clear a typed query. The bin deletes; "Clear"
// clears or dismisses. No cross icon or cross glyph may appear in any other
// app source file under src. Test files are skipped: they assert on rendered
// markup, not author it. Allowlist: X_ALLOWED (IconX only, by file). The
// one carve-out is by form, not by file: the heavy multiplication emoji in its
// emoji presentation (U+2716 U+FE0F) is a pickable emoji in the generated
// emoji dataset (chat/emoji-data.ts), user content rather than a UI cross; the
// bare text glyph U+2716 is still banned.
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ICONS = fileURLToPath(new URL('../components/ui/icons.tsx', import.meta.url));

/** The cross icon names and glyphs that may not appear in app source. */
const BANNED: { name: string; re: RegExp }[] = [
  { name: 'IconX', re: /\bIconX\b/ },
  { name: 'XMarkIcon', re: /XMarkIcon/ },
  { name: 'XCircleIcon', re: /XCircleIcon/ },
  { name: '×', re: /×/ },
  { name: '✕', re: /✕/ },
  { name: '✖', re: /\u2716(?!\uFE0F)/ },
  { name: '⨯', re: /⨯/ },
];

/** The only files that may use IconX (the glyphs stay banned everywhere). */
export const X_ALLOWED: readonly string[] = [
  'components/ui/icons.tsx',
  'components/ui/UploadRing.tsx',
  'components/ui/PendingChip.tsx',
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
      if ((name === 'IconX' || name === 'XMarkIcon') && X_ALLOWED.includes(rel)) continue;
      if (re.test(line)) out.push(`${rel}:${i + 1} ${name}`);
    }
  });
  return out;
}

describe('no cross anywhere', () => {
  it('no non-test file under src uses IconX (outside X_ALLOWED), XMarkIcon, XCircleIcon or a cross glyph', () => {
    const offenders = sourceFiles(ROOT).flatMap((path) =>
      crossUses(relative(ROOT, path).split(sep).join('/'), readFileSync(path, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('icons.tsx exports IconX for the upload cancel / file remove only', () => {
    const src = readFileSync(ICONS, 'utf8');
    expect(src).toMatch(/export\s+function\s+IconX\b/);
    expect(crossUses('components/ui/UploadRing.tsx', 'import { IconX } from x')).toEqual([]);
    expect(crossUses('components/ui/PendingChip.tsx', '<IconX />')).toEqual([]);
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
    // The pickable emoji (emoji presentation) is content, not a UI cross.
    expect(crossUses('emoji-data.ts', "['\u2716\uFE0F', 'multiply', 7]")).toEqual([]);
  });
});
