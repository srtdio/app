import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Lighting: one light straight above. Every surface takes exactly one lit-*
// class from src/index.css (docs/lighting.md); a call site never carries its
// own box-shadow, shadow-*, drop-shadow or backdrop-blur.
const ROOT = fileURLToPath(new URL('../components/', import.meta.url));
const CSS = readFileSync(fileURLToPath(new URL('../index.css', import.meta.url)), 'utf8');
const BLUR_ALLOWED = new Set(['ui/ImageLightbox.tsx', 'ui/FileViewer.tsx']);
// The guide spotlight is a cut-out, not a light: it keeps its own token.
const SPOTLIGHT = 'shadow-[var(--shadow-spotlight)]';

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
      const clean = line.split(SPOTLIGHT).join('');
      if (re.test(clean)) out.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  return out;
}

const DEFINED = new Set([...CSS.matchAll(/\.(lit-[a-z-]+)/g)].map((m) => m[1]));
const src = (rel: string) => FILES.find((f) => f.rel === rel)?.src ?? '';

describe('lighting rules', () => {
  it('no Tailwind shadow or drop-shadow class on a call site', () => {
    expect(
      hits(/(^|[\s"'`:])(shadow|shadow-(sm|md|lg|xl|2xl|inner|none)|drop-shadow(-[\w[\]().-]+)?)(?=[\s"'`]|$)/),
    ).toEqual([]);
  });

  it('no arbitrary shadow value or box-shadow property', () => {
    expect(hits(/shadow-\[|\[box-shadow:|drop-shadow-\[/)).toEqual([]);
  });

  it('no inline boxShadow style', () => {
    expect(hits(/\bboxShadow\b/)).toEqual([]);
  });

  it('backdrop-blur only on the image viewer and file viewer backdrops', () => {
    expect(hits(/backdrop-blur/, (rel) => BLUR_ALLOWED.has(rel))).toEqual([]);
  });

  it('every lit-* class used is defined in src/index.css', () => {
    const used = new Set<string>();
    for (const { src: s } of FILES) {
      for (const m of s.matchAll(/(?<![\w-])(lit-[a-z]+(?:-[a-z]+)*)(?![\w-])/g)) used.add(m[1]);
    }
    expect([...used].filter((c) => !DEFINED.has(c)).sort()).toEqual([]);
  });

  it('index.css defines every lighting class in both themes', () => {
    for (const c of [
      'lit-raised',
      'lit-card',
      'lit-card-muted',
      'lit-float',
      'lit-overlay',
      'lit-header',
      'lit-side',
      'lit-dock',
      'lit-btn-primary',
      'lit-btn-success',
      'lit-btn-danger',
      'lit-btn-secondary',
      'lit-chip',
      'lit-chip-selected',
      'lit-well',
      'lit-well-soft',
      'lit-pill',
      'lit-tint',
      'lit-active',
      'lit-knob',
      'lit-media',
      'lit-avatar',
      'lit-badge',
      'lit-bubble-own',
      'lit-bubble-other',
    ]) {
      expect(DEFINED.has(c), c).toBe(true);
      const token = `--${c}:`;
      expect(CSS.split(token).length - 1, token).toBe(2);
    }
    expect(CSS).not.toMatch(/transition[^;]*box-shadow/);
  });

  it('the old shadow tokens are gone; the spotlight stays', () => {
    expect(CSS).not.toMatch(/--shadow-card|--strip-shadow|--shadow-panel-left/);
    expect(CSS).toContain('--shadow-spotlight:');
  });

  it('the shared primitives carry their lit class', () => {
    const button = src('ui/Button.tsx');
    for (const c of ['lit-btn-primary', 'lit-btn-secondary', 'lit-btn-success', 'lit-btn-danger']) {
      expect(button, c).toContain(c);
    }
    expect(src('ui/Chip.tsx')).toContain('lit-chip');
    expect(src('ui/Chip.tsx')).toContain('lit-chip-selected');
    expect(src('ui/Input.tsx')).toContain('lit-well');
    expect(src('ui/Sheet.tsx')).toContain('lit-overlay');
    expect(src('ui/popover-classes.ts')).toContain('lit-overlay');
    expect(src('shell/BottomTabs.tsx')).toContain('lit-raised');
    expect(src('ui/toast/Toast.tsx')).toContain('lit-float');
  });
});
