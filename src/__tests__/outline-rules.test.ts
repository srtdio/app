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

/** The outline family, in @layer utilities so the line beats any border-* / bg-* utility. */
const OUTLINES = [
  'lit-selected',
  'lit-focus',
  'lit-focus-inset',
  'lit-bad',
  'lit-drop',
  'lit-today',
] as const;
const OUTLINE_SET: ReadonlySet<string> = new Set(OUTLINES);
// These paint the element's border or inset edge: a neutral border or ring
// utility on the same element fights them.
const EDGE_OUTLINES: ReadonlySet<string> = new Set([
  'lit-selected',
  'lit-bad',
  'lit-drop',
  'lit-today',
]);
const EDGE_CLASH = /^(border-border|border-panel(-[\w-]+)?|ring(-.+)?)(\/[\w.[\]]+)?$/;
// lit-focus is an outline: it leaves the border alone (a divider row keeps its
// border-b border-border), but a ring beside it is a second focus line.
const RING_CLASH = /^ring(-.+)?$/;

// focus:outline-none without lit-focus, each with its reason: the element
// takes programmatic focus only (a dialog panel or heading, tabIndex -1) or its
// focus line is drawn by a wrapper (focus-within).
const OUTLINE_NONE_ALLOW: ReadonlyMap<string, string> = new Map([
  ['ui/Sheet.tsx', 'the sheet panel takes programmatic focus on open; its controls draw the line'],
  ['ui/SidePanel.tsx', 'the side panel takes programmatic focus on open'],
  ['ui/PersonCard.tsx', 'the popover box takes programmatic focus on open'],
  ['ui/Backdrop.tsx', 'the dim layer is a click target, never a keyboard stop'],
  ['chat/tasks/TaskSheet.tsx', 'the task sheet panel takes programmatic focus on open'],
  ['chat/MessageActionMenu.tsx', 'the emoji popover and sheet take programmatic focus on open'],
  ['pages/create/ComposerSheet.tsx', 'the composer sheet panel takes programmatic focus on open'],
  ['pages/assets/AssetLightbox.tsx', 'media viewer: the overlay takes programmatic focus on open'],
  ['chat/PlanScreen.tsx', 'the plan panel and its heading (tabIndex -1) take programmatic focus'],
  ['pages/BriefCard.tsx', 'the stretched card link: the card draws focus-within:lit-focus'],
  ['shell/PageHead.tsx', 'the screen h1 (tabIndex -1) takes programmatic focus on navigation'],
  [
    'ui/HeaderBar.tsx',
    'the bar h1 (routeFocus) and a panel title column (titleProps tabIndex -1) take programmatic focus only',
  ],
  ['chat/tasks/TaskRow.tsx', 'borderless inline title edit (CLAUDE.md text-field exception)'],
]);

// NavLink / role="button" / tabIndex 0 without lit-focus, each with its reason.
const FOCUSABLE_ALLOW: ReadonlyMap<string, string> = new Map([
  ['pages/assets/AssetLightbox.tsx', 'media viewer: overlay controls keep the overlay-fg ring'],
  ['pages/pcs/PostLightbox.tsx', 'media viewer: overlay controls keep the overlay-fg ring'],
  [
    'pages/HelpPage.tsx',
    'quick links are chip faces: the imported CHIP_HIT draws lit-focus on the face span',
  ],
]);

function lineOf(src: string, index: number): number {
  return src.slice(0, index).split('\n').length;
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

/** The start of the JSX tag that holds `at` (the nearest `<Name` before it), or -1. */
function tagStart(src: string, at: number): number {
  for (let i = at; i >= 0; i -= 1) {
    if (src[i] === '<' && /[A-Za-z]/.test(src[i + 1] ?? '')) return i;
  }
  return -1;
}

/** The end (exclusive) of the balanced run opened at `open` ((, [ or {). */
function balancedEnd(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return src.length;
}

/** SCREAMING_CASE constants holding a string, with their right-hand side, in one file. */
function constants(src: string): Map<string, { text: string; at: number }> {
  const out = new Map<string, { text: string; at: number }>();
  const re = /(?:^|\n)[ \t]*(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\b[^=\n]*=\s*/g;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    const from = m.index + m[0].length;
    let i = from;
    // Up to the ';' outside any bracket (a cn(...) or an array may wrap lines).
    while (i < src.length && src[i] !== ';') {
      i = '([{'.includes(src[i] ?? '') ? balancedEnd(src, i) : i + 1;
    }
    const text = src.slice(from, i);
    if (/['"`]/.test(text)) out.set(m[1] ?? '', { text, at: m.index + 1 });
  }
  return out;
}

/** The constants a tag names, resolved two levels deep (A = cn(B, '...')). */
function constantsIn(src: string, tag: string): string {
  const table = constants(src);
  const seen = new Set<string>();
  const walk = (text: string, depth: number): string =>
    [...text.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)]
      .map((m) => m[1] ?? '')
      .filter((name) => table.has(name) && !seen.has(name))
      .map((name) => {
        seen.add(name);
        const rhs = table.get(name)?.text ?? '';
        return depth > 0 ? `${rhs} ${walk(rhs, depth - 1)}` : rhs;
      })
      .join(' ');
  // Class helpers called in the tag (bubbleClass(...)): their body counts too.
  const helpers = [...tag.matchAll(/\b([a-z][A-Za-z0-9]*)\(/g)]
    .map((m) => m[1] ?? '')
    .map((name) => {
      const at = src.search(new RegExp(`function ${name}\\(`));
      if (at < 0) return '';
      // The body opens after the parameter list and an optional return type.
      const sig = /\)\s*(?::[^{;=]*)?\{/g;
      sig.lastIndex = at;
      const hit = sig.exec(src);
      if (hit === null) return '';
      const open = hit.index + hit[0].length - 1;
      return src.slice(open, balancedEnd(src, open));
    })
    .join(' ');
  return `${walk(tag, 1)} ${helpers}`;
}

/**
 * Every class-bearing unit in a file: each className attribute (a string or a
 * balanced {...}) and each SCREAMING_CASE constant holding a string. A unit is
 * one element's classes (a class constant styles one element).
 */
function classUnits(src: string): { text: string; at: number }[] {
  const out: { text: string; at: number }[] = [];
  const re = /className=/g;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    const start = m.index + m[0].length;
    const open = src[start];
    if (open === '"' || open === "'") {
      const end = src.indexOf(open, start + 1);
      if (end > start) out.push({ text: src.slice(start, end + 1), at: m.index });
    } else if (open === '{') {
      out.push({ text: src.slice(start + 1, balancedEnd(src, start) - 1), at: m.index });
    }
  }
  for (const { text, at } of constants(src).values()) out.push({ text, at });
  return out;
}

/**
 * The string literals of an expression. `conditional` marks a literal that
 * applies only under a condition (after &&, ||, ??, ? or :), so the two
 * branches of one ternary never count as one element.
 */
function literals(text: string): { value: string; conditional: boolean }[] {
  const out: { value: string; conditional: boolean }[] = [];
  const conditionalAt = (at: number): boolean =>
    /(&&|\|\||\?\?|\?|:)$/.test(text.slice(0, at).trimEnd());
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "'" || c === '"') {
      const end = text.indexOf(c, i + 1);
      if (end < 0) break;
      out.push({ value: text.slice(i + 1, end), conditional: conditionalAt(i) });
      i = end + 1;
    } else if (c === '`') {
      const conditional = conditionalAt(i);
      let j = i + 1;
      let value = '';
      while (j < text.length && text[j] !== '`') {
        if (text[j] === '$' && text[j + 1] === '{') {
          const end = balancedEnd(text, j + 1);
          for (const inner of literals(text.slice(j + 2, end - 1))) {
            out.push({ value: inner.value, conditional: conditional || inner.conditional });
          }
          j = end;
        } else {
          value += text[j];
          j += 1;
        }
      }
      out.push({ value, conditional });
      i = j + 1;
    } else i += 1;
  }
  return out;
}

/** Class tokens with their variants (hover:, focus-visible:, [&_x]:) stripped. */
function classTokens(value: string): string[] {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => {
      let depth = 0;
      let cut = -1;
      for (let i = 0; i < t.length; i += 1) {
        if (t[i] === '[') depth += 1;
        else if (t[i] === ']') depth -= 1;
        else if (t[i] === ':' && depth === 0) cut = i;
      }
      return t.slice(cut + 1);
    });
}

/** The bodies of every `@layer <name> {` block in index.css, joined. */
function layer(name: string): string {
  const out: string[] = [];
  const re = new RegExp(`@layer ${name} \\{`, 'g');
  for (let m = re.exec(CSS); m !== null; m = re.exec(CSS)) {
    const open = m.index + m[0].length - 1;
    out.push(CSS.slice(open + 1, balancedEnd(CSS, open) - 1));
  }
  return out.join('\n');
}

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
      // Chip draws it on its visible face ([&:focus-visible>span]:lit-focus, CHIP_HIT);
      // its Clear pill is a ui/Button, which carries it.
      expect(src, rel).toMatch(/focus-visible(>span\])?:lit-focus/);
    }
  });

  it('index.css defines the outline family from --sel-edge in both themes', () => {
    const flat = CSS.replace(/\s+/g, ' ');
    // One value per theme block; the own bubble re-points it (below).
    const themeBlock = (sel: string): string =>
      new RegExp(`^${sel.replace('.', '\\.')} \\{([\\s\\S]*?)^\\}`, 'm').exec(CSS)?.[1] ?? '';
    for (const sel of [':root', '.dark']) {
      expect(themeBlock(sel).split('--sel-edge:').length - 1, sel).toBe(1);
    }
    expect(flat).toContain('--sel-edge: #08090a;');
    expect(flat).toContain('--sel-edge: rgba(255, 255, 255, 0.92);');
    const body = (c: string): string => flat.split(`.${c} {`)[1]?.split('}')[0] ?? '';
    expect(body('lit-selected')).toContain('border-color: var(--sel-edge)');
    expect(body('lit-focus')).toContain('outline: 1.5px solid var(--sel-edge)');
    expect(body('lit-focus')).not.toContain('box-shadow');
    expect(body('lit-focus-inset')).toContain('outline: 1.5px solid var(--sel-edge)');
    expect(body('lit-focus-inset')).toContain('outline-offset: -2px');
    expect(body('lit-bad')).toContain('border-color: var(--bad)');
    // 1px dashed (no layout shift against a 1px border) plus an inset ring.
    expect(body('lit-drop')).toContain('1px dashed var(--sel-edge)');
    expect(body('lit-drop')).toContain('inset 0 0 0 1px var(--sel-edge)');
    expect(body('lit-today')).toContain('inset 0 0 0 1px var(--sel-edge)');
    // No tint, no glow: nothing in the family reads the accent tokens.
    for (const c of OUTLINES) {
      expect(body(c), c).not.toMatch(/accent/);
    }
    expect(CSS).not.toMatch(/\.lit-chip-selected|--lit-chip-selected/);
    expect(CSS).not.toMatch(/transition(-property)?:[^;]*outline/);
  });

  it('inside the own bubble the outline is on-bubble ink (data-own)', () => {
    const flat = CSS.replace(/\s+/g, ' ');
    expect(flat).toContain('[data-own] { --sel-edge: var(--on-bubble); }');
  });

  it('the six outline classes live in @layer utilities, after every lit-* height', () => {
    const utilities = layer('utilities');
    const components = layer('components');
    expect(utilities, '@layer utilities block').not.toBe('');
    for (const c of OUTLINES) {
      expect(utilities, c).toMatch(new RegExp(`\\.${c} \\{`));
      // Defined once, in utilities: never a second copy in components.
      expect(components, c).not.toMatch(new RegExp(`\\.${c} \\{`));
    }
    expect(CSS.lastIndexOf('@layer utilities')).toBeGreaterThan(
      CSS.lastIndexOf('@layer components'),
    );
  });

  it('no element combines an outline class with border-border, border-panel* or ring-*', () => {
    const offenders: string[] = [];
    for (const { rel, src } of FILES) {
      if (isMediaOverlay(rel)) continue;
      for (const unit of classUnits(src)) {
        const lits = literals(unit.text).map((l) => ({ ...l, toks: classTokens(l.value) }));
        for (const a of lits) {
          for (const outline of a.toks.filter((t) => OUTLINE_SET.has(t))) {
            const clash = EDGE_OUTLINES.has(outline) ? EDGE_CLASH : RING_CLASH;
            for (const b of lits) {
              const bad = b.toks.find((t) => clash.test(t));
              if (bad === undefined) continue;
              // Two branches of one condition (a ? 'lit-selected' : 'border-border')
              // never meet on one element.
              if (a !== b && a.conditional && b.conditional) continue;
              offenders.push(`${rel}:${lineOf(src, unit.at)}: ${outline} + ${bad}`);
            }
          }
        }
      }
    }
    expect([...new Set(offenders)]).toEqual([]);
  });

  it('no focus:outline-none without lit-focus on the same element', () => {
    const offenders: string[] = [];
    for (const { rel, src } of FILES) {
      if (isMediaOverlay(rel) || OUTLINE_NONE_ALLOW.has(rel)) continue;
      for (const unit of classUnits(src)) {
        if (!/(^|[\s"'`:])(focus|focus-visible):outline-none\b/.test(unit.text)) continue;
        if (/\blit-focus(-inset)?\b/.test(unit.text)) continue;
        offenders.push(`${rel}:${lineOf(src, unit.at)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every NavLink, role="button" and tabIndex 0 element draws the focus line', () => {
    const offenders: string[] = [];
    for (const { rel, src } of FILES) {
      if (isMediaOverlay(rel) || FOCUSABLE_ALLOW.has(rel)) continue;
      const seen = new Set<number>();
      const re = /<NavLink\b|role=["']button["']|role:\s*'button'|tabIndex=\{0\}|tabIndex:\s*0\b/g;
      for (let m = re.exec(src); m !== null; m = re.exec(src)) {
        const start = m[0].startsWith('<') ? m.index : tagStart(src, m.index);
        if (start < 0 || seen.has(start)) continue;
        const tag = openingTag(src, start);
        // A props object built outside JSX (spread later): not this tag.
        if (start + tag.length < m.index) continue;
        seen.add(start);
        // A locked row (aria-disabled) is not a control.
        if (/aria-disabled=["']true["']/.test(tag)) continue;
        const text = `${tag} ${constantsIn(src, tag)}`;
        if (/\blit-focus(-inset)?\b|focus-visible:outline-overlay-fg/.test(text)) continue;
        offenders.push(`${rel}:${lineOf(src, start)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every outline allowlist entry names a file that exists and gives a reason', () => {
    for (const [rel, reason] of [...OUTLINE_NONE_ALLOW, ...FOCUSABLE_ALLOW]) {
      expect(
        FILES.some((f) => f.rel === rel),
        rel,
      ).toBe(true);
      expect(reason.length, rel).toBeGreaterThan(10);
    }
  });
});

// Search is a tool, not a field to fill: every type="search" input is
// ui/Input tone="search" (quiet well at rest; ink line, lit-focus and lift on
// focus). Each exception with its reason.
const SEARCH_TONE_ALLOW: ReadonlyMap<string, string> = new Map([
  ['cockpit/tabs.tsx', 'operator Cockpit logs search: outside the search-tone PR, follow-up'],
  ['pages/HelpPage.tsx', 'Help page search: outside the search-tone PR, follow-up'],
]);

describe('outline rules: search tone', () => {
  it('no type="search" input without tone="search"', () => {
    const offenders: string[] = [];
    for (const { rel, src } of FILES) {
      if (SEARCH_TONE_ALLOW.has(rel)) continue;
      const re = /<(?:Input|input)\b/g;
      for (let m = re.exec(src); m !== null; m = re.exec(src)) {
        const tag = openingTag(src, m.index);
        if (!/\btype=["']search["']/.test(tag)) continue;
        if (/\btone=["']search["']/.test(tag)) continue;
        offenders.push(`${rel}:${lineOf(src, m.index)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('ui/Input search tone: no line at rest; the ink line, lit-focus and lift on focus', () => {
    const input = readFileSync(join(ROOT, 'ui/Input.tsx'), 'utf8');
    const search = /search:\s*'([^']+)'/.exec(input)?.[1] ?? '';
    const toks = search.split(/\s+/);
    for (const t of [
      'border-transparent',
      'bg-panel-2',
      'lit-well',
      'focus:border-field',
      'focus:bg-panel',
      'focus:lit-card',
    ]) {
      expect(toks, t).toContain(t);
    }
    expect(toks).not.toContain('border-field');
    expect(input).toContain('focus:lit-focus');
  });

  it('every search-tone allowlist entry names a file that exists and gives a reason', () => {
    for (const [rel, reason] of SEARCH_TONE_ALLOW) {
      expect(
        FILES.some((f) => f.rel === rel),
        rel,
      ).toBe(true);
      expect(reason.length, rel).toBeGreaterThan(10);
    }
  });
});
