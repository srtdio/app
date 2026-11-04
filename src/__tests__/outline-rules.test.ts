import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Outlines: one family from --sel-edge, a crisp ink line in light and a crisp
// white line in dark, no tint, no glow (docs/lighting.md "Outlines"). Call sites
// take only lit-selected (picked / active), lit-focus (focus), lit-bad (error),
// lit-drop (drop target) and lit-today (today). Every hit prints as file:line.
const ROOT = fileURLToPath(new URL('../components/', import.meta.url));
const CSS = readFileSync(fileURLToPath(new URL('../index.css', import.meta.url)), 'utf8');

// Overlay controls on media keep their own white focus ring; the induction
// spotlight keeps --shadow-spotlight (a cut-out, not an outline).
const MEDIA_OVERLAY: ReadonlyMap<string, string> = new Map([
  ['ui/ImageLightbox.tsx', 'controls over a full-screen image'],
  ['ui/FileViewer.tsx', 'controls over a full-screen file'],
  ['ui/PhotoViewer.tsx', 'controls over a full-screen person photo'],
]);
const isMediaOverlay = (rel: string): boolean =>
  MEDIA_OVERLAY.has(rel) || rel.startsWith('ui/viewers/');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

const FILES = sources(ROOT)
  .map((path) => relative(ROOT, path).split(sep).join('/'))
  .filter((rel) => !rel.startsWith('home/'))
  .filter((rel) => !/\.test\.tsx?$/.test(rel) && !rel.includes('__tests__/'))
  .map((rel) => ({ rel, src: readFileSync(join(ROOT, rel), 'utf8') }));

function hits(re: RegExp, skip: (rel: string) => boolean = () => false): string[] {
  const out: string[] = [];
  for (const { rel, src } of FILES) {
    if (skip(rel)) continue;
    src.split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      // The spotlight (guide box, preview window) is a cut-out, not an outline.
      if (line.includes('--shadow-spotlight')) return;
      if (re.test(line)) out.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  return out;
}

// A class token, with or without variants (hover:, focus-visible:, group-*:)
// and an /opacity suffix.
const token = (names: string): RegExp => new RegExp(`(^|[\\s"'\`:])(${names})(?=[\\s"'\`/]|$)`);

describe('outline rules', () => {
  it('no accent outline or retired selected class on a call site', () => {
    expect(
      hits(
        token('border-accent|border-accent-line|ring-accent|ring-accent-line|lit-chip-selected'),
        isMediaOverlay,
      ),
    ).toEqual([]);
  });

  it('focus is lit-focus (an outline); only media overlay controls keep a ring', () => {
    expect(hits(/(^|[\s"'`])(group-)?focus(-visible|-within)?:ring-/, isMediaOverlay)).toEqual([]);
  });

  it('the shared controls carry the one focus line', () => {
    for (const rel of ['ui/Button.tsx', 'ui/IconButton.tsx', 'ui/Chip.tsx']) {
      const src = FILES.find((f) => f.rel === rel)?.src ?? '';
      expect(src, rel).toContain('focus-visible:lit-focus');
    }
  });

  it('index.css defines the outline family from --sel-edge in both themes', () => {
    const flat = CSS.replace(/\s+/g, ' ');
    expect(CSS.split('--sel-edge:').length - 1).toBe(2);
    expect(flat).toContain('--sel-edge: #08090a;');
    expect(flat).toContain('--sel-edge: rgba(255, 255, 255, 0.92);');
    const body = (c: string): string => flat.split(`.${c} {`)[1]?.split('}')[0] ?? '';
    expect(body('lit-selected')).toContain('border-color: var(--sel-edge)');
    expect(body('lit-focus')).toContain('outline: 1.5px solid var(--sel-edge)');
    expect(body('lit-focus')).not.toContain('box-shadow');
    expect(body('lit-bad')).toContain('border-color: var(--bad)');
    expect(body('lit-drop')).toContain('dashed var(--sel-edge)');
    expect(body('lit-today')).toContain('inset 0 0 0 1px var(--sel-edge)');
    // No tint, no glow: nothing in the family reads the accent tokens.
    for (const c of ['lit-selected', 'lit-focus', 'lit-bad', 'lit-drop', 'lit-today']) {
      expect(body(c), c).not.toMatch(/accent/);
    }
    expect(CSS).not.toMatch(/\.lit-chip-selected|--lit-chip-selected/);
    expect(CSS).not.toMatch(/transition(-property)?:[^;]*outline/);
  });
});
