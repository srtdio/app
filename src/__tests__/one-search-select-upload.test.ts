import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Design lock (7 Nov 2026), CLAUDE.md "Top bar", "Select", "Upload":
// - one search: no tone="search" Input outside CommandPalette, HelpPage and the
//   operator Cockpit (pickers search through CommandPalette pick mode);
// - one upload look: no role="progressbar" outside ui/UploadRing, except the
//   non-upload progress listed in PROGRESS_ALLOWED;
// - one select circle: no hand-built rounded-full tick circle outside ui/SelectCheck;
// - one pending-file chip: PendingChip is defined only in ui/PendingChip.
const ROOT = fileURLToPath(new URL('../', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === '__tests__' || name === 'node_modules' ? [] : sourceFiles(path);
    }
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const FILES = sourceFiles(ROOT).map((path) => ({
  rel: relative(ROOT, path).split(sep).join('/'),
  src: readFileSync(path, 'utf8'),
}));

/** The only places a search field may live. */
export const SEARCH_ALLOWED = (rel: string): boolean =>
  rel === 'components/shell/CommandPalette.tsx' ||
  rel.endsWith('/HelpPage.tsx') ||
  rel.startsWith('components/cockpit/');

/** role="progressbar" allowed by file: the upload ring, and progress that is not an upload. */
export const PROGRESS_ALLOWED: readonly string[] = [
  'components/ui/UploadRing.tsx',
  // A plan's approval progress (not an upload).
  'components/chat/PlanCard.tsx',
  // The tour's step progress (not an upload).
  'components/induction/GuideParts.tsx',
];

/** "file:line" for each search field in a source text. Pure. */
export function searchFields(rel: string, src: string): string[] {
  if (SEARCH_ALLOWED(rel)) return [];
  const out: string[] = [];
  src.split('\n').forEach((line, i) => {
    if (/tone=["{']+search/.test(line)) out.push(`${rel}:${i + 1}`);
  });
  return out;
}

/** "file:line" for each progressbar outside PROGRESS_ALLOWED. Pure. */
export function progressBars(rel: string, src: string): string[] {
  if (PROGRESS_ALLOWED.includes(rel)) return [];
  const out: string[] = [];
  src.split('\n').forEach((line, i) => {
    if (/role=["{']+progressbar/.test(line)) out.push(`${rel}:${i + 1}`);
  });
  return out;
}

/**
 * "file:line" for each hand-built select circle: a rounded-full box with a
 * tick (IconCheck) within six lines and a selection fill or state word. Pure.
 */
export function handBuiltSelectCircles(rel: string, src: string): string[] {
  if (rel === 'components/ui/SelectCheck.tsx') return [];
  const lines = src.split('\n');
  const out: string[] = [];
  lines.forEach((line, i) => {
    if (!line.includes('rounded-full')) return;
    const win = lines.slice(Math.max(0, i - 6), i + 7).join('\n');
    if (!/\bIconCheck\b/.test(win)) return;
    if (/\bbg-accent\b|\bchecked\b|\bchosen\b|\bselected\b|\bpicked\b/.test(win)) {
      out.push(`${rel}:${i + 1}`);
    }
  });
  return out;
}

describe('one search, one upload look, one select circle (7 Nov 2026)', () => {
  it('no tone="search" Input outside CommandPalette, HelpPage and the Cockpit', () => {
    expect(FILES.flatMap((f) => searchFields(f.rel, f.src))).toEqual([]);
  });

  it('no role="progressbar" outside ui/UploadRing and the non-upload whitelist', () => {
    expect(FILES.flatMap((f) => progressBars(f.rel, f.src))).toEqual([]);
  });

  it('no hand-built rounded-full select circle outside ui/SelectCheck', () => {
    expect(FILES.flatMap((f) => handBuiltSelectCircles(f.rel, f.src))).toEqual([]);
  });

  it('PendingChip is defined only in ui/PendingChip', () => {
    const defs = FILES.filter((f) =>
      /export\s+(function|const)\s+PendingChip\b|^function\s+PendingChip\b/m.test(f.src),
    ).map((f) => f.rel);
    expect(defs).toEqual(['components/ui/PendingChip.tsx']);
  });

  it('UploadRing is defined only in ui/UploadRing', () => {
    const defs = FILES.filter((f) => /export\s+function\s+UploadRing\b/.test(f.src)).map(
      (f) => f.rel,
    );
    expect(defs).toEqual(['components/ui/UploadRing.tsx']);
  });

  it('the detectors flag their forms and pass clean text', () => {
    expect(searchFields('components/pages/X.tsx', '<Input tone="search" />')).toEqual([
      'components/pages/X.tsx:1',
    ]);
    expect(searchFields('components/shell/CommandPalette.tsx', '<Input tone="search" />')).toEqual(
      [],
    );
    expect(progressBars('components/pages/X.tsx', 'a\n<div role="progressbar" />')).toEqual([
      'components/pages/X.tsx:2',
    ]);
    expect(progressBars('components/chat/PlanCard.tsx', '<div role="progressbar" />')).toEqual([]);
    expect(
      handBuiltSelectCircles(
        'components/x/Y.tsx',
        '<span className="h-6 w-6 rounded-full bg-accent">\n<IconCheck />\n</span>',
      ),
    ).toEqual(['components/x/Y.tsx:1']);
    expect(
      handBuiltSelectCircles(
        'components/x/Y.tsx',
        '<span className="rounded-full bg-good-soft" />',
      ),
    ).toEqual([]);
  });
});
