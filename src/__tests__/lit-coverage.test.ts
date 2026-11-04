import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Lighting covers every surface: an element whose className has a fill
// (bg-panel, bg-panel-2, bg-panel-3, bg-bg, bg-*-soft) plus a radius plus a
// border or padding is a surface, so it takes a lit-* height (docs/lighting.md).
// A flat surface is allowed only with a reason below. Every hit prints as
// file:line.
const ROOT = fileURLToPath(new URL('../components/', import.meta.url));

// file -> reason. A file here is skipped whole; keep the list short.
const ALLOW: ReadonlyMap<string, string> = new Map([
  ['ui/ImageLightbox.tsx', 'media viewer: full-screen media, no lit surface'],
  ['ui/PhotoViewer.tsx', 'media viewer: full-screen person photo'],
  ['ui/FileViewer.tsx', 'media viewer; the PDF page is paper and stays flat'],
  [
    'pages/activity/AvatarStack.tsx',
    'the +N counter sits in an avatar stack; its ring-bg cut-out separates it from the avatar beside it',
  ],
]);
const allowed = (rel: string): boolean =>
  ALLOW.has(rel) || rel.startsWith('ui/viewers/') || rel.startsWith('home/');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx$/.test(name) ? [path] : [];
  });
}

const FILES = sources(ROOT)
  .map((path) => relative(ROOT, path).split(sep).join('/'))
  .filter((rel) => !/\.test\.tsx$/.test(rel) && !rel.includes('__tests__/'))
  .map((rel) => ({ rel, src: readFileSync(join(ROOT, rel), 'utf8') }));

// One className attribute: className="..." or className={...} with balanced
// braces. Returns the attribute text and its start offset.
function classNames(src: string): { text: string; at: number }[] {
  const out: { text: string; at: number }[] = [];
  const re = /className=/g;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    const start = m.index + m[0].length;
    const open = src[start];
    if (open === '"' || open === "'") {
      const end = src.indexOf(open, start + 1);
      if (end > start) out.push({ text: src.slice(start + 1, end), at: m.index });
      continue;
    }
    if (open !== '{') continue;
    let depth = 0;
    let i = start;
    for (; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      if (src[i] === '}') depth -= 1;
      if (depth === 0) break;
    }
    out.push({ text: src.slice(start + 1, i), at: m.index });
  }
  return out;
}

// Utility tokens only (variants like hover: or md: do not make the base surface).
const base = (text: string): string[] =>
  text
    .split(/[\s"'`(),?]+/)
    .filter(Boolean)
    .filter((t) => !t.includes(':'));

const FILL = /^bg-(panel|panel-2|panel-3|bg|[a-z]+-soft)$/;
const RADIUS = /^rounded(-|$)/;
const EDGE_OR_PAD = /^(border|border-[a-z0-9-]+|p[xytrbl]?-[\w.[\]]+)$/;

function offenders(): string[] {
  const out: string[] = [];
  for (const { rel, src } of FILES) {
    if (allowed(rel)) continue;
    for (const { text, at } of classNames(src)) {
      // The flat full-bleed and the zero-radius rows are not surfaces.
      if (/\blit-[a-z-]+/.test(text)) continue;
      // Loading bones (mv-bone) are Flat; the induction spotlight is a cut-out.
      if (/\bmv-bone\b|--shadow-spotlight/.test(text)) continue;
      const toks = base(text);
      const fill = toks.some((t) => FILL.test(t));
      const radius = toks.some((t) => RADIUS.test(t) && t !== 'rounded-none');
      const edge = toks.some((t) => EDGE_OR_PAD.test(t) && !/^border-(t|b|l|r|x|y)$/.test(t));
      if (fill && radius && edge) {
        const line = src.slice(0, at).split('\n').length;
        out.push(`${rel}:${line}: ${text.replace(/\s+/g, ' ').trim().slice(0, 140)}`);
      }
    }
  }
  return out;
}

describe('lit coverage', () => {
  it('every filled, rounded surface with an edge or padding takes a lit-* class', () => {
    expect(offenders()).toEqual([]);
  });

  it('every allow-list entry names a file that exists and gives a reason', () => {
    for (const [rel, reason] of ALLOW) {
      expect(
        FILES.some((f) => f.rel === rel),
        rel,
      ).toBe(true);
      expect(reason.length, rel).toBeGreaterThan(10);
    }
  });
});
