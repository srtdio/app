import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { BoneLit } from '@/lib/motion/react';

// Lighting covers every surface: an element whose className has a fill
// (bg-panel, bg-panel-2, bg-panel-3, bg-bg, bg-*-soft, bg-accent*, bg-good-solid,
// bg-strip) plus a radius plus a border or padding is a surface, so it takes a
// lit-* height (docs/lighting.md). Only a base lit class counts: a variant
// (focus-visible:lit-focus, aria-[invalid]:lit-bad) or an outline / state
// modifier (lit-focus, lit-bad, lit-drop, lit-today, lit-hover, lit-press,
// lit-page, lit-fill) is not a height. className attributes and SCREAMING_CASE
// class constants are both read. A flat surface is allowed only with a reason
// below. Every hit prints as file:line.
const ROOT = fileURLToPath(new URL('../components/', import.meta.url));

// file -> reason. A file here is skipped whole; keep the list short.
const ALLOW: ReadonlyMap<string, string> = new Map([
  ['ui/ImageLightbox.tsx', 'media viewer: full-screen media, no lit surface'],
  ['ui/PhotoViewer.tsx', 'media viewer: full-screen person photo'],
  ['ui/FileViewer.tsx', 'media viewer; the PDF page is paper and stays flat'],
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
    .split(/[\s"'`(),?{}]+/)
    .filter(Boolean)
    .filter((t) => !t.includes(':'));

const FILL = /^bg-(panel|panel-2|panel-3|bg|[a-z]+-soft|accent(-[a-z]+)?|good-solid|strip)$/;
const RADIUS = /^rounded(-|$)/;
const EDGE_OR_PAD = /^(border|border-[a-z0-9-]+|p[xytrbl]?-[\w.[\]]+)$/;
// Outline and state modifiers ride on a height; they are not one.
const NOT_A_HEIGHT = new Set([
  'lit-focus',
  'lit-focus-inset',
  'lit-bad',
  'lit-drop',
  'lit-today',
  'lit-hover',
  'lit-press',
  'lit-page',
  'lit-fill',
  'lit-edges',
]);
const hasHeight = (toks: string[]): boolean =>
  toks.some((t) => /^lit-[a-z-]+$/.test(t) && !NOT_A_HEIGHT.has(t));

/** SCREAMING_CASE constants holding classes (const NAME = '...' / cn(...) / `...`). */
function classConstants(src: string): { text: string; at: number }[] {
  const out: { text: string; at: number }[] = [];
  // A constant styling a loading box (<Bone className={NAME} lit="...">)
  // takes its light from the lit prop, checked below.
  const onShell = (name: string): boolean =>
    new RegExp(`<(Bone|BoxSkeleton)\\b[^>]*\\{${name}\\}`).test(src);
  const re = /(?:^|\n)[ \t]*(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\b[^=\n]*=\s*/g;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    const from = m.index + m[0].length;
    let i = from;
    let depth = 0;
    for (; i < src.length; i += 1) {
      const c = src[i];
      if (c === '(' || c === '[' || c === '{') depth += 1;
      else if (c === ')' || c === ']' || c === '}') depth -= 1;
      else if (c === ';' && depth <= 0) break;
    }
    const text = src
      .slice(from, i)
      .trim()
      .replace(/\s+as const$/, '');
    // A class string, not a number, a regex or a component.
    if (!/['"`]/.test(text) || /^(\(|function|async|new |\/)/.test(text)) continue;
    if (onShell(m[1] ?? '')) continue;
    // A look map ({ selected: '...', plain: '...' }) styles one element per
    // entry: each entry is its own unit.
    for (const piece of text.startsWith('{') ? topLevelParts(text.slice(1, -1)) : [text]) {
      out.push({ text: piece, at: m.index + 1 });
    }
  }
  return out;
}

/** The comma-separated parts of a list, split only outside brackets. */
function topLevelParts(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of text) {
    if (c === '(' || c === '[' || c === '{') depth += 1;
    if (c === ')' || c === ']' || c === '}') depth -= 1;
    if (c === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function offenders(): string[] {
  const out: string[] = [];
  for (const { rel, src } of FILES) {
    if (allowed(rel)) continue;
    for (const { text, at } of [...classNames(src), ...classConstants(src)]) {
      // Loading bones (mv-bone) carry their lit prop (checked below); the
      // induction spotlight is a cut-out.
      if (/\bmv-bone\b|--shadow-spotlight/.test(text)) continue;
      const toks = base(text);
      // The flat full-bleed and the zero-radius rows are not surfaces.
      if (hasHeight(toks)) continue;
      const fill = toks.some((t) => FILL.test(t));
      const radius = toks.some((t) => RADIUS.test(t) && t !== 'rounded-none');
      const edge = toks.some((t) => EDGE_OR_PAD.test(t) && !/^border-(t|b|l|r|x|y)$/.test(t));
      if (fill && radius && edge) {
        const line = src.slice(0, at).split('\n').length;
        out.push(`${rel}:${line}: ${text.replace(/\s+/g, ' ').trim().slice(0, 140)}`);
      }
    }
  }
  return [...new Set(out)];
}

// The lit heights a loading box may take (BoneLit in src/lib/motion/react.tsx).
const BONE_LITS: readonly BoneLit[] = [
  'flat',
  'lit-card',
  'lit-card-muted',
  'lit-well',
  'lit-media',
  'lit-avatar',
  'lit-pill',
  'lit-badge',
  'lit-chip',
  'lit-btn-secondary',
  'lit-raised',
  'lit-bubble-own',
  'lit-bubble-other',
];
const CSS = readFileSync(fileURLToPath(new URL('../index.css', import.meta.url)), 'utf8');
// <Bone ... lit="x"> / lit={'x'} / lit={expr}.
const BONE_LIT = /<(Bone|BoxSkeleton)\b[^>]*?\blit=(?:"([^"]*)"|\{'([^']*)'\}|\{([^}]*)\})/g;

describe('lit coverage', () => {
  it('every filled, rounded surface with an edge or padding takes a lit-* class', () => {
    expect(offenders()).toEqual([]);
  });

  it('a variant-only lit class does not count as a height', () => {
    const focusOnly = 'rounded-lg border bg-panel-2 px-3 focus-visible:lit-focus';
    expect(hasHeight(base(focusOnly))).toBe(false);
    expect(hasHeight(base('rounded-lg border bg-panel-2 aria-[invalid]:lit-bad'))).toBe(false);
    expect(hasHeight(base('rounded-lg border bg-panel-2 lit-focus'))).toBe(false);
    expect(hasHeight(base('rounded-lg border bg-panel-2 lit-well'))).toBe(true);
  });

  it('every Bone and BoxSkeleton lit prop is a lit height defined in index.css (or flat)', () => {
    const bad: string[] = [];
    for (const { rel, src } of FILES) {
      for (const m of src.matchAll(BONE_LIT)) {
        const value = m[2] ?? m[3];
        const line = src.slice(0, m.index).split('\n').length;
        // A passed-through prop (lit={lit}) is typed BoneLit; a literal is checked here.
        if (value === undefined) continue;
        const known = (BONE_LITS as readonly string[]).includes(value);
        const defined = value === 'flat' || new RegExp(`\\.${value}[ ,{]`).test(CSS);
        if (!known || !defined) bad.push(`${rel}:${line}: lit="${value}"`);
      }
    }
    expect(bad).toEqual([]);
    for (const lit of BONE_LITS) {
      if (lit === 'flat') continue;
      expect(CSS, lit).toMatch(new RegExp(`\\.${lit}[ ,{]`));
    }
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
