import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Viewport: the iOS keyboard and the toolbar resize vh, so a component sizes
// against svh (static) or dvh (where the keyboard matters), never plain vh
// (CLAUDE.md "App height"). A full-screen panel with a 56px header pads its
// top by the safe area (status bar / Dynamic Island), and the phone tab bar and
// the fixed bottom docks keep clear of the side insets in landscape. Every hit
// prints as file:line.
const ROOT = fileURLToPath(new URL('../components/', import.meta.url));

// file -> reason. Skipped by the vh rule.
const VH_ALLOW: ReadonlyMap<string, string> = new Map([
  ['dev/MarksPanel.tsx', 'dev only: the marks panel behind a dev flag'],
  ['chat/PaintLog.tsx', 'dev only: the ?paintlog=1 panel'],
]);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(tsx?|css)$/.test(name) ? [path] : [];
  });
}

const FILES = sources(ROOT)
  .map((path) => relative(ROOT, path).split(sep).join('/'))
  .filter((rel) => !/\.test\.tsx?$/.test(rel) && !rel.includes('__tests__/'))
  .map((rel) => ({ rel, src: readFileSync(join(ROOT, rel), 'utf8') }));
const TSX = FILES.filter(({ rel }) => /\.tsx?$/.test(rel) && !rel.startsWith('home/'));
const src = (rel: string): string => FILES.find((f) => f.rel === rel)?.src ?? '';

// The inset itself, or the shared 56px-plus-inset bar (lib/scroll-mode.ts
// SAFE_TOP_BAR_CLASS; ModalPanel's MODAL_HEADER_SAFE re-exports it).
const SAFE_TOP = /safe-area-inset-top|--shell-safe-top|SAFE_TOP_BAR_CLASS|MODAL_HEADER_SAFE/;
const SCROLL_MODE = readFileSync(
  fileURLToPath(new URL('../lib/scroll-mode.ts', import.meta.url)),
  'utf8',
);
const SAFE_BOTTOM = /safe-area-inset-bottom/;
const SAFE_SIDES = (text: string): boolean =>
  /safe-area-inset-left/.test(text) && /safe-area-inset-right/.test(text);

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

/** The end (exclusive) of the balanced run opened at `open` ((, [ or {). */
function balancedEnd(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

/** Each className attribute and each SCREAMING_CASE class constant: one element's classes. */
function classUnits(text: string): { text: string; at: number }[] {
  const out: { text: string; at: number }[] = [];
  for (const m of text.matchAll(/className=/g)) {
    const start = m.index + m[0].length;
    const open = text[start];
    if (open === '"' || open === "'") {
      const end = text.indexOf(open, start + 1);
      if (end > start) out.push({ text: text.slice(start, end + 1), at: m.index });
    } else if (open === '{') {
      out.push({ text: text.slice(start, balancedEnd(text, start)), at: m.index });
    }
  }
  const constant = /(?:^|\n)[ \t]*(?:export\s+)?const\s+[A-Z][A-Z0-9_]*\b[^=\n]*=\s*/g;
  for (const m of text.matchAll(constant)) {
    const from = m.index + m[0].length;
    let i = from;
    while (i < text.length && text[i] !== ';') {
      i = '([{'.includes(text[i] ?? '') ? balancedEnd(text, i) : i + 1;
    }
    out.push({ text: text.slice(from, i), at: m.index + 1 });
  }
  return out;
}

/** Base utility tokens (no variant), so md:fixed or max-[891px]:inset-y-0 do not count. */
const base = (text: string): string[] =>
  text
    .split(/[\s"'`(),?{}]+/)
    .filter(Boolean)
    .filter((t) => !t.includes(':'));

/** A full-screen panel: fixed, pinned to the full height, with its own fill. */
const isFullPanel = (text: string): boolean => {
  const toks = base(text);
  return (
    toks.includes('fixed') &&
    (toks.includes('inset-0') || toks.includes('inset-y-0')) &&
    toks.some((t) => /^bg-(bg|panel|panel-2|overlay)$/.test(t))
  );
};

describe('viewport rules', () => {
  it('no plain vh: svh (static) or dvh (keyboard); a vh fallback only beside its twin', () => {
    const offenders: string[] = [];
    for (const { rel, src: text } of FILES) {
      if (VH_ALLOW.has(rel)) continue;
      text.split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        for (const m of line.matchAll(/(?<![\w.])(\d+(?:\.\d+)?)vh(?=[\])])/g)) {
          // max-h-[90vh] supports-[height:1dvh]:max-h-[90dvh]: an old-engine
          // fallback, allowed only with its svh / dvh twin on the same line.
          const twin = new RegExp(`(?<![\\w.])${m[1]}(s|d)vh\\b`);
          if (!twin.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('a full-screen panel with an h-14 header pads its top by the safe area', () => {
    const offenders: string[] = [];
    for (const { rel, src: text } of TSX) {
      const panels = classUnits(text).filter((u) => isFullPanel(u.text));
      if (panels.length === 0) continue;
      if (!/(^|[\s"'`])h-14(?=[\s"'`])/.test(text)) continue;
      if (!SAFE_TOP.test(text)) {
        offenders.push(`${rel}:${lineOf(text, panels[0]?.at ?? 0)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the shared full-screen pages and viewers clear the status bar', () => {
    const bar = /SAFE_TOP_BAR_CLASS\s*=\s*([^;]+);/.exec(SCROLL_MODE)?.[1] ?? '';
    expect(bar, 'lib/scroll-mode.ts SAFE_TOP_BAR_CLASS').toContain('--shell-safe-top');
    // Contact, Group info and Starred: the modal page header takes the safe bar.
    expect(src('chat/ModalPanel.tsx')).toMatch(/MODAL_HEADER_SAFE\s*=\s*SAFE_TOP_BAR_CLASS/);
    for (const { rel, src: text } of TSX) {
      if (rel === 'chat/ModalPanel.tsx') continue;
      if (
        !/<ModalPanel\b|\bMODAL_PAGE_CLASS\b|fixed inset-0 z-sheet flex flex-col bg-bg/.test(text)
      ) {
        continue;
      }
      expect(text, `${rel}: modal page header`).toMatch(SAFE_TOP);
    }
    for (const rel of ['ui/ImageLightbox.tsx', 'preview/PlatformPreviewPanel.tsx']) {
      expect(src(rel), rel).toMatch(SAFE_TOP);
    }
  });

  it('the bottom-anchored sheets and panels clear the home indicator', () => {
    for (const rel of ['preview/PlatformPreviewPanel.tsx', 'pages/create/FilePromptSheet.tsx']) {
      expect(src(rel), rel).toMatch(SAFE_BOTTOM);
    }
  });

  it('the phone tab bar keeps clear of the side insets (landscape notch)', () => {
    const tabs = src('shell/BottomTabs.tsx');
    const offsets = /PHONE_BAR_OFFSETS\s*=\s*([^;]+);/.exec(tabs)?.[1] ?? '';
    expect(SAFE_SIDES(offsets || tabs)).toBe(true);
  });

  it('every fixed bottom dock (lit-dock) keeps clear of the side insets', () => {
    const offenders: string[] = [];
    for (const { rel, src: text } of TSX) {
      for (const unit of classUnits(text)) {
        const toks = base(unit.text);
        if (!toks.includes('lit-dock') || !toks.includes('fixed')) continue;
        if (!SAFE_SIDES(unit.text)) offenders.push(`${rel}:${lineOf(text, unit.at)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every allowlist entry names a file that exists and gives a reason', () => {
    for (const [rel, reason] of VH_ALLOW) {
      expect(
        FILES.some((f) => f.rel === rel),
        rel,
      ).toBe(true);
      expect(reason.length, rel).toBeGreaterThan(10);
    }
  });
});
