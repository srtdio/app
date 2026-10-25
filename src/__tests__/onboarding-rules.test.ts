import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The design rules (CLAUDE.md) on the pre-app steps, setup and tour. Reads every
// source file under onboarding/ and induction/ with no exemptions; the shared
// rule tests (no-inline-svg, no-raw-button, copy-rules, detail-rules) also scan
// both folders with none.
const ROOT = fileURLToPath(new URL('../components/', import.meta.url));
const DIRS = ['onboarding', 'induction'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const FILES: { rel: string; src: string }[] = DIRS.flatMap((dir) => sourceFiles(join(ROOT, dir)))
  .map((path) => ({ path, rel: relative(ROOT, path).split(sep).join('/') }))
  .map(({ path, rel }) => ({ rel, src: readFileSync(path, 'utf8') }));

/** "file:line match" for every match of `re` across the scanned files. */
function hits(re: RegExp): string[] {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  const global = new RegExp(re.source, flags);
  return FILES.flatMap(({ rel, src }) =>
    Array.from(src.matchAll(global), (m) => {
      const line = src.slice(0, m.index).split('\n').length;
      return `${rel}:${line} ${m[0]}`;
    }),
  );
}

/** The JSX opening tag starting at `start`, up to its closing `>` outside any `{...}`. */
function openingTag(src: string, start: number): string {
  let depth = 0;
  for (let i = start; i < src.length; i += 1) {
    const c = src[i];
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    else if (c === '>' && depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
}

/** "file:line" for each opening `<tag` whose text matches `bad`. */
function tagsMatching(tag: RegExp, bad: (open: string) => boolean): string[] {
  const global = new RegExp(tag.source, 'g');
  return FILES.flatMap(({ rel, src }) =>
    Array.from(src.matchAll(global))
      .filter((m) => bad(openingTag(src, m.index)))
      .map((m) => `${rel}:${src.slice(0, m.index).split('\n').length}`),
  );
}

describe('onboarding and induction follow the design rules', () => {
  it('scans both folders', () => {
    expect(FILES.some(({ rel }) => rel === 'onboarding/OnboardingFlow.tsx')).toBe(true);
    expect(FILES.some(({ rel }) => rel === 'induction/GuideParts.tsx')).toBe(true);
  });

  it('buttons use a named variant, never the legacy "default" alias', () => {
    expect(hits(/variant=\{?[^}\n>]*['"]default['"]/)).toEqual([]);
  });

  it('a Button never takes meta colour (text-fg-3) or an amber fill layer', () => {
    expect(tagsMatching(/<Button\b/, (open) => /text-fg-3|--guide/.test(open))).toEqual([]);
  });

  it('fields render through ui/Input; raw <input only for a file picker or the zoom range', () => {
    expect(tagsMatching(/<input\b/, (open) => !/type="(file|range)"/.test(open))).toEqual([]);
  });

  it('no inline <svg (the guide hand is IconHand in ui/icons.tsx)', () => {
    expect(hits(/<svg\b/)).toEqual([]);
  });

  it('zoom controls are icons, not "-" and "+" text glyphs', () => {
    expect(hits(/>\s*[-+]\s*<\/span>/)).toEqual([]);
  });

  it('shadows follow the roles: no drop-shadow, no card shadow', () => {
    expect(hits(/\bdrop-shadow\b|drop-shadow-|--shadow-card/)).toEqual([]);
  });

  it('colours with a token class use it, not an arbitrary var()', () => {
    expect(hits(/-\[var\(--overlay-[a-z-]+\)\]/)).toEqual([]);
  });

  it('type stays on the role scale: no text-xs', () => {
    expect(hits(/\btext-xs\b/)).toEqual([]);
  });

  it('motion reads the tokens: no raw durations or easing keywords', () => {
    expect(hits(/\bduration-\d+|\bduration-\[/)).toEqual([]);
    expect(hits(/\b\d+(\.\d+)?m?s\s+(ease|linear|cubic-bezier)/)).toEqual([]);
    expect(hits(/\bease-(in-out|out|in)\b/)).toEqual([]);
  });

  it('cards are 12, the step card 16, and only the step card carries a shadow', () => {
    const flow = FILES.find(({ rel }) => rel === 'onboarding/OnboardingFlow.tsx')?.src ?? '';
    expect(flow).toContain('rounded-2xl border border-border bg-panel p-6 shadow-2xl');
    expect(flow).toContain('max-w-[340px] rounded-xl border border-border bg-panel p-3.5"');
  });

  it('the intro card is the step card role on the panel: Start primary, Skip tour ghost', () => {
    const guide = FILES.find(({ rel }) => rel === 'induction/GuideParts.tsx')?.src ?? '';
    expect(guide).toContain("kind === 'intro' ? 'rounded-2xl border-border'");
    expect(guide).toContain('border bg-panel p-4 text-fg shadow-2xl');
    expect(guide).not.toMatch(/bg-accent text-accent-fg|text-accent-fg/);
    expect(guide).toContain('<Button variant="primary" onClick={onPress}>');
    // Skip tour is ghost (text-fg-2), which contrast.test holds at 4.5:1 on panel in both themes.
    expect(guide).not.toMatch(/variant=\{hero/);
  });

  it('errors read "Couldn\'t {action}. {reason}"', () => {
    const literals = hits(/setError\((['"`])(?:(?!\1).)*\1/);
    expect(literals.length).toBeGreaterThan(0);
    expect(literals.filter((hit) => !/setError\(['"`]Couldn't [^.]+\. /.test(hit))).toEqual([]);
  });
});
