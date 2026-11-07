// Design ratchet: counts one-off layout values in src/ and fails when any count
// rises above scripts/design-ratchet.baseline.json. Counts may only go down.
//
//   node --experimental-strip-types --no-warnings scripts/design-ratchet.ts            check
//   node --experimental-strip-types --no-warnings scripts/design-ratchet.ts --verbose  + file:line lists
//   node --experimental-strip-types --no-warnings scripts/design-ratchet.ts --update   lower the baseline
//
// --update never raises a number: fix the code instead. The per-file checks
// (scanSource) are exported for scripts/claude-design-hook.ts, which runs them
// on every file Claude Code edits.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export interface Hit {
  metric: Metric;
  file: string;
  line: number;
  /** The offending value. For distinct metrics this is the value that is counted once. */
  value: string;
}

export const METRICS = {
  arbitraryPx: {
    distinct: false,
    what: 'arbitrary px in a spacing or size class (p-[18px], h-[30px])',
    fix: 'Use the 4px scale (1,2,3,4,6,8,12) or the shared part that owns the size (CLAUDE.md L1).',
  },
  offGrid: {
    distinct: false,
    what: 'spacing off the 4px grid (*-1.5, *-2.5, *-3.5, [Npx] not divisible by 4)',
    fix: 'Use a 4px step: 1, 2, 3, 4, 6, 8, 12. 0.5 only inside badges and pills (CLAUDE.md L1).',
  },
  zValues: {
    distinct: true,
    what: 'distinct z-index values',
    fix: 'Use a named stacking token (z-raised, z-sticky, z-nav, z-dock, z-sheet, z-dialog, z-toast; tailwind.config.ts zIndex).',
  },
  zArbitrary: {
    distinct: false,
    what: 'arbitrary z-[N]',
    fix: 'Never z-[N]; use a named stacking token (tailwind.config.ts zIndex).',
  },
  leading: {
    distinct: false,
    what: 'leading-* override',
    fix: 'Font sizes carry their line height; use a text role, not leading-* (CLAUDE.md L9).',
  },
  tracking: {
    distinct: false,
    what: 'tracking-* use',
    fix: 'Only the section label role tracks; use the role, not tracking-* (CLAUDE.md L9).',
  },
  borderWidth: {
    distinct: false,
    what: 'border width other than 1 (border-2, border-4, border-[Npx])',
    fix: 'Edges are 1px (border, border-strong); state lines use lit-selected / lit-focus.',
  },
  cardPadding: {
    distinct: true,
    what: 'distinct padding sets on bg-panel + rounded-* elements (card insides)',
    fix: 'Reuse an existing card padding (p-4 md:p-6 style); inside <= outside (CLAUDE.md L3).',
  },
  dotSizes: {
    distinct: true,
    what: 'distinct rounded-full dot sizes (<= 10px)',
    fix: 'Reuse an existing dot size (h-2 w-2) or the shared dot part.',
  },
  iconSizes: {
    distinct: true,
    what: 'distinct size values per IconX / IconChevron* / IconSearch / IconPlus / IconCheck',
    fix: 'Use the ICON_SIZE role this icon already uses elsewhere (ui/icons.tsx).',
  },
  iconSizeLiteral: {
    distinct: false,
    what: 'icon size={number} literal',
    fix: 'Use ICON_SIZE.* from src/components/ui/icons.tsx.',
  },
  rawImg: {
    distinct: false,
    what: 'raw <img> without width/height or a size class',
    fix: 'Use Avatar / Thumbnail / a ui image part with a fixed size.',
  },
  threeDots: {
    distinct: false,
    what: '"..." three dots in a string',
    fix: 'Use the ellipsis character (U+2026).',
  },
  keyIndex: {
    distinct: false,
    what: 'key={i} / key={index} / key={idx}',
    fix: 'Key by a stable id from the data, never the array index.',
  },
  outlineNone: {
    distinct: false,
    what: 'outline-none without a lit-focus / focus-visible style on the same element',
    fix: 'Use Button / IconButton / Chip (they carry focus-visible:lit-focus) or add it.',
  },
  nowrap: {
    distinct: false,
    what: 'whitespace-nowrap without truncate / overflow-* / shrink-0',
    fix: 'Add truncate (or shrink-0 on a fixed label) so text never spills (CLAUDE.md L8).',
  },
  exitMix: {
    distinct: false,
    what: 'files with an X exit and a < exit (any label but remove/clear/previous)',
    fix: 'One exit per panel: Back (IconChevronLeft) on pages, X only for remove/clear/dismiss.',
  },
  handTap: {
    distinct: false,
    what: 'tap control whose VISIBLE height (h-N on it or its first child) is under 44px',
    fix: 'Use Button / IconButton / Chip / PressableRow at 44 (CLAUDE.md B1).',
  },
  fullWidthButton: {
    distinct: false,
    what: '<Button w-full> with no md: width override',
    fix: 'Full width on phone only: add md:w-auto (CLAUDE.md B2).',
  },
  designDisables: {
    distinct: false,
    what: 'eslint-disable for no-restricted-syntax (design rule exemptions)',
    fix: 'Fix the code instead of disabling the rule; a disable needs a reason after --.',
  },
} as const;

export type Metric = keyof typeof METRICS;
export const METRIC_NAMES = Object.keys(METRICS) as Metric[];
export type Counts = Record<Metric, number>;

// ---------------------------------------------------------------- class helpers

/** Split "md:hover:p-[18px]" into variants and base, ignoring ':' inside [...]. */
export function splitVariant(token: string): { variants: string; base: string } {
  let depth = 0;
  let cut = -1;
  for (let i = 0; i < token.length; i++) {
    const ch = token[i];
    if (ch === '[' || ch === '(') depth++;
    else if (ch === ']' || ch === ')') depth--;
    else if (ch === ':' && depth === 0) cut = i;
  }
  const variants = cut >= 0 ? token.slice(0, cut + 1) : '';
  let base = cut >= 0 ? token.slice(cut + 1) : token;
  if (base.startsWith('!')) base = base.slice(1);
  if (base.startsWith('-')) base = base.slice(1);
  return { variants, base };
}

const SPACE_PREFIX =
  '(?:p[trblxyse]?|m[trblxyse]?|gap(?:-[xy])?|space-[xy]|top|left|right|bottom|start|end|inset(?:-[xy])?|h|w|size|min-[hw]|max-[hw])';
const ARBITRARY_PX = new RegExp(`^${SPACE_PREFIX}-\\[(-?\\d+(?:\\.\\d+)?)px\\]$`);
const HALF_STEP = new RegExp(`^${SPACE_PREFIX}-(1\\.5|2\\.5|3\\.5)$`);
const Z_TOKEN = /^z-(\d+|\[[^\]]+\])$/;
const LEADING = /^leading-(none|tight|snug|normal|relaxed|loose|\d+|\[[^\]]+\])$/;
const TRACKING = /^tracking-(tighter|tight|normal|wide|wider|widest|\[[^\]]+\])$/;
const BORDER_WIDTH = /^border(?:-[xytrblse])?-(2|4|8|\[\d+(?:\.\d+)?px\])$/;
const PADDING = /^p[trblxyse]?-/;
const HEIGHT_SMALL = /^(?:h|size)-(5|6|7|8|9|10|\[(\d+(?:\.\d+)?)px\])$/;
const ICONS_TRACKED = /^(IconX|IconChevron\w*|IconSearch|IconPlus|IconCheck)$/;
const TAP_PRIMITIVES = new Set(['Button', 'IconButton', 'Chip', 'PressableRow']);
/** The type-role table: the one file whose leading-* / tracking-* are the roles themselves. */
export const TYPE_ROLE_FILE = 'src/components/ui/Text.tsx';

/** Class-like tokens in a string (whitespace split). */
function tokens(text: string): string[] {
  return text.split(/\s+/).filter((t) => t.length > 0 && t.length < 120);
}

function classTokenHits(token: string): Array<{ metric: Metric; value: string }> {
  const out: Array<{ metric: Metric; value: string }> = [];
  const { base } = splitVariant(token);
  const px = ARBITRARY_PX.exec(base);
  if (px) {
    out.push({ metric: 'arbitraryPx', value: token });
    const n = Number(px[1]);
    if (n % 4 !== 0 && Math.abs(n) !== 2) out.push({ metric: 'offGrid', value: token });
  }
  if (HALF_STEP.test(base)) out.push({ metric: 'offGrid', value: token });
  const z = Z_TOKEN.exec(base);
  if (z) {
    out.push({ metric: 'zValues', value: `z-${z[1]}` });
    if (z[1]?.startsWith('[')) out.push({ metric: 'zArbitrary', value: token });
  }
  if (LEADING.test(base)) out.push({ metric: 'leading', value: token });
  if (TRACKING.test(base)) out.push({ metric: 'tracking', value: token });
  if (BORDER_WIDTH.test(base)) out.push({ metric: 'borderWidth', value: token });
  return out;
}

function pxOf(value: string): number | null {
  const arb = /^\[(\d+(?:\.\d+)?)px\]$/.exec(value);
  if (arb) return Number(arb[1]);
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value) * 4;
  if (value === 'px') return 1;
  return null;
}

/** The first JSX element child of an element (its visible face), if any. */
function firstChildElement(full: ts.Node): ts.JsxOpeningElement | ts.JsxSelfClosingElement | null {
  if (!ts.isJsxElement(full)) return null;
  for (const child of full.children) {
    if (ts.isJsxElement(child)) return child.openingElement;
    if (ts.isJsxSelfClosingElement(child)) return child;
    if (ts.isJsxText(child) && child.text.trim() !== '') return null;
  }
  return null;
}

/** The first plain (no variant) h-N / size-N / h-[Npx] under 44 among the element's classes. */
function smallHeight(attrs: ts.JsxAttributes): string | null {
  for (const t of elementTokens(attrs)) {
    const { variants, base } = splitVariant(t);
    if (variants !== '') continue;
    const m = HEIGHT_SMALL.exec(base);
    if (!m) continue;
    if (m[2] !== undefined && Number(m[2]) >= 44) continue;
    return base;
  }
  return null;
}

// ---------------------------------------------------------------- AST scan

function tagName(node: ts.JsxTagNameExpression): string {
  return node.getText();
}

function attrString(attrs: ts.JsxAttributes, name: string): string | null {
  for (const p of attrs.properties) {
    if (!ts.isJsxAttribute(p) || p.name.getText() !== name) continue;
    if (!p.initializer) return '';
    if (ts.isStringLiteral(p.initializer)) return p.initializer.text;
    if (ts.isJsxExpression(p.initializer) && p.initializer.expression) {
      return p.initializer.expression.getText();
    }
  }
  return null;
}

function hasAttr(attrs: ts.JsxAttributes, name: string): boolean {
  return attrs.properties.some((p) => ts.isJsxAttribute(p) && p.name.getText() === name);
}

/** Every class-like token in the element's attributes (className, cn(...) args, ternaries). */
function elementTokens(attrs: ts.JsxAttributes): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push(...tokens(n.text));
    else if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
      out.push(...tokens(n.text));
    }
    ts.forEachChild(n, visit);
  };
  for (const p of attrs.properties) {
    if (!ts.isJsxAttribute(p)) continue;
    const name = p.name.getText();
    if (name !== 'className' && name !== 'class') continue;
    if (p.initializer) visit(p.initializer);
  }
  return out;
}

function containsIcon(node: ts.Node, names: RegExp): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (
      (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) &&
      names.test(tagName(n.tagName))
    ) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** All hits in one file. `file` is the repo-relative path used in messages. */
export function scanSource(file: string, src: string): Hit[] {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind);
  const hits: Hit[] = [];
  const lineOf = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const add = (metric: Metric, node: ts.Node | number, value: string): void => {
    const pos = typeof node === 'number' ? node : node.getStart(sf);
    hits.push({ metric, file, line: lineOf(pos), value });
  };
  let exitX = 0;
  let exitBack = 0;
  let firstExit = -1;

  const roleTable = file === TYPE_ROLE_FILE;
  const stringText = (n: ts.Node, text: string): void => {
    for (const t of tokens(text))
      for (const h of classTokenHits(t)) {
        if (roleTable && (h.metric === 'leading' || h.metric === 'tracking')) continue;
        add(h.metric, n, h.value);
      }
    if (text.includes('...')) add('threeDots', n, text.slice(0, 40));
  };

  const element = (node: ts.JsxOpeningElement | ts.JsxSelfClosingElement, full: ts.Node): void => {
    const name = tagName(node.tagName);
    const attrs = node.attributes;
    const toks = elementTokens(attrs);
    const bases = toks.map((t) => splitVariant(t));
    const plain = bases.filter((b) => b.variants === '').map((b) => b.base);
    const has = (re: RegExp): boolean => plain.some((b) => re.test(b));

    // h. card insides
    if (plain.includes('bg-panel') && has(/^rounded(-|$)/)) {
      const pads = toks.filter((t) => PADDING.test(splitVariant(t).base)).sort();
      if (pads.length > 0) add('cardPadding', node, pads.join(' '));
    }
    // i. dots
    if (plain.includes('rounded-full') && !has(/^px-/)) {
      let h: number | null = null;
      let w: number | null = null;
      for (const b of plain) {
        const m = /^(h|w|size)-(.+)$/.exec(b);
        if (!m || !m[2]) continue;
        const v = pxOf(m[2]);
        if (v === null) continue;
        if (m[1] === 'h' || m[1] === 'size') h = v;
        if (m[1] === 'w' || m[1] === 'size') w = v;
      }
      if (h !== null && w !== null && h <= 10 && w <= 10) add('dotSizes', node, `${w}x${h}`);
    }
    // j, k. icons
    if (/^Icon[A-Z]/.test(name)) {
      const size = attrString(attrs, 'size');
      if (size !== null) {
        if (/^\d+(\.\d+)?$/.test(size)) add('iconSizeLiteral', node, `${name} size={${size}}`);
        if (ICONS_TRACKED.test(name)) add('iconSizes', node, `${name}:${size}`);
      }
    }
    // l. raw img
    if (name === 'img') {
      const sized =
        (hasAttr(attrs, 'width') && hasAttr(attrs, 'height')) ||
        has(/^(h|w|size)-/) ||
        has(/^(min-|max-)?(h|w)-/);
      if (!sized) add('rawImg', node, '<img>');
    }
    // n. key index
    const key = attrString(attrs, 'key');
    if (key !== null && /^(i|index|idx)$/.test(key)) add('keyIndex', node, `key={${key}}`);
    // o. outline-none
    if (toks.some((t) => splitVariant(t).base === 'outline-none')) {
      const focusStyled = toks.some(
        (t) =>
          t.includes('lit-focus') ||
          (t.startsWith('focus-visible:') && !t.endsWith('outline-none')),
      );
      if (!focusStyled) add('outlineNone', node, 'outline-none');
    }
    // p. nowrap
    if (plain.includes('whitespace-nowrap')) {
      const guarded = has(/^(truncate|shrink-0|flex-none|overflow-|text-ellipsis)/);
      if (!guarded) add('nowrap', node, 'whitespace-nowrap');
    }
    // r. tap control whose VISIBLE height is under 44: the box itself (any
    // clickable, primitives included, since a className can shrink one) or
    // its first child (the face a 44 hit box draws).
    const clickable =
      TAP_PRIMITIVES.has(name) ||
      hasAttr(attrs, 'onClick') ||
      attrString(attrs, 'role') === 'button';
    if (clickable) {
      const own = smallHeight(attrs);
      const face = firstChildElement(full);
      const inner = own === null && face !== null ? smallHeight(face.attributes) : null;
      if (own !== null) add('handTap', node, `<${name}> ${own}`);
      else if (inner !== null) add('handTap', node, `<${name}> face ${inner}`);
    }
    // s. full-width Button with no md: width
    if (name === 'Button' && plain.includes('w-full')) {
      const mdWidth = toks.some((t) => /^(md|lg):(w|max-w)-/.test(t));
      if (!mdWidth) add('fullWidthButton', node, '<Button w-full>');
    }
    // q. exits: a tap control holding IconX or IconChevronLeft is an exit
    // whatever its label says ("Close", "Done", "Cancel", "Back"), except the
    // X's the Exit rule allows (remove / clear / dismiss / delete / cancel
    // upload / stop) and chevrons that step through content (previous, move).
    if (clickable) {
      const label = `${attrString(attrs, 'aria-label') ?? ''} ${attrString(attrs, 'label') ?? ''}`;
      const text = full.getText(sf);
      const allowedX = /\b(remove|clear|dismiss|delete|stop|cancel upload|unpin|discard)\b/i;
      const stepBack = /\b(previous|prev|earlier|move|left|calendar|month)\b/i;
      const isX = containsIcon(full, /^IconX$/) && !allowedX.test(label) && !allowedX.test(text);
      const isBack =
        containsIcon(full, /^IconChevronLeft$/) && !stepBack.test(label) && !stepBack.test(text);
      if (isX) exitX++;
      if (isBack) exitBack++;
      if ((isX || isBack) && firstExit < 0) firstExit = node.getStart(sf);
    }
  };

  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      // Import / export paths are not copy or classes.
      if (!ts.isImportDeclaration(n.parent) && !ts.isExportDeclaration(n.parent)) {
        stringText(n, n.text);
      }
    } else if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
      stringText(n, n.text);
    } else if (ts.isJsxText(n)) {
      if (n.text.includes('...')) add('threeDots', n, n.text.trim().slice(0, 40));
    } else if (ts.isJsxElement(n)) {
      element(n.openingElement, n);
    } else if (ts.isJsxSelfClosingElement(n)) {
      element(n, n);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);

  if (exitX > 0 && exitBack > 0) add('exitMix', firstExit, 'IconX + IconChevronLeft exits');

  const disable = /eslint-disable(?:-next-line|-line)?\s+[^\n]*(?:no-restricted-syntax|design\/)/g;
  let m: RegExpExecArray | null;
  while ((m = disable.exec(src)) !== null) add('designDisables', m.index, m[0].slice(0, 60));

  return hits;
}

// ---------------------------------------------------------------- repo scan

export function isScanned(rel: string): boolean {
  const p = rel.split(sep).join('/');
  if (!p.startsWith('src/')) return false;
  if (!/\.(ts|tsx)$/.test(p) || p.endsWith('.d.ts')) return false;
  if (/\.test\.(ts|tsx)$/.test(p) || p.includes('/__tests__/')) return false;
  if (p.startsWith('src/components/dev/')) return false;
  return true;
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
}

/** Scan root/src. Returns every hit with repo-relative paths. */
export function scanRepo(root: string): Hit[] {
  const files: string[] = [];
  const srcDir = join(root, 'src');
  if (existsSync(srcDir)) walk(srcDir, files);
  const hits: Hit[] = [];
  for (const full of files.sort()) {
    const rel = relative(root, full).split(sep).join('/');
    if (!isScanned(rel)) continue;
    hits.push(...scanSource(rel, readFileSync(full, 'utf8')));
  }
  return hits;
}

export function countHits(hits: Hit[]): Counts {
  const counts = {} as Counts;
  for (const metric of METRIC_NAMES) {
    const mine = hits.filter((h) => h.metric === metric);
    counts[metric] = METRICS[metric].distinct
      ? new Set(mine.map((h) => h.value)).size
      : mine.length;
  }
  return counts;
}

export interface Comparison {
  raised: Array<{ metric: Metric; count: number; baseline: number }>;
  lowered: Array<{ metric: Metric; count: number; baseline: number }>;
  missing: Metric[];
}

export function compare(counts: Counts, baseline: Partial<Record<string, number>>): Comparison {
  const result: Comparison = { raised: [], lowered: [], missing: [] };
  for (const metric of METRIC_NAMES) {
    const base = baseline[metric];
    const count = counts[metric];
    if (base === undefined) result.missing.push(metric);
    else if (count > base) result.raised.push({ metric, count, baseline: base });
    else if (count < base) result.lowered.push({ metric, count, baseline: base });
  }
  return result;
}

/**
 * The baseline --update would write. Throws when any count is above its
 * baseline: the baseline only ever goes down. Missing metrics are added.
 */
export function lowerBaseline(
  counts: Counts,
  baseline: Partial<Record<string, number>>,
): Record<Metric, number> {
  const { raised } = compare(counts, baseline);
  if (raised.length > 0) {
    const list = raised.map((r) => `${r.metric} ${r.baseline} -> ${r.count}`).join(', ');
    throw new Error(`Refusing to raise the design baseline (${list}). Fix the code instead.`);
  }
  const next = {} as Record<Metric, number>;
  for (const metric of METRIC_NAMES)
    next[metric] = Math.min(counts[metric], baseline[metric] ?? counts[metric]);
  return next;
}

function changedFiles(root: string): Set<string> | null {
  const base = process.env.DESIGN_RATCHET_BASE ?? 'origin/main';
  try {
    const git = (args: string[]): string =>
      execFileSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    const mergeBase = git(['merge-base', base, 'HEAD']).trim();
    const out = git(['diff', '--name-only', mergeBase]);
    const untracked = git(['ls-files', '--others', '--exclude-standard']);
    return new Set(`${out}\n${untracked}`.split('\n').filter(Boolean));
  } catch {
    return null;
  }
}

export interface RunOptions {
  root: string;
  baselinePath: string;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

/** CLI entry, returns the exit code. */
export function run(argv: string[], opts: RunOptions): number {
  const log = opts.log ?? ((l: string) => process.stdout.write(`${l}\n`));
  const error = opts.error ?? ((l: string) => process.stderr.write(`${l}\n`));
  const verbose = argv.includes('--verbose');
  const update = argv.includes('--update');

  const hits = scanRepo(opts.root);
  const counts = countHits(hits);
  const baseline: Partial<Record<string, number>> = existsSync(opts.baselinePath)
    ? (JSON.parse(readFileSync(opts.baselinePath, 'utf8')) as Record<string, number>)
    : {};

  log(JSON.stringify(counts, null, 2));
  if (verbose) {
    for (const metric of METRIC_NAMES) {
      const mine = hits.filter((h) => h.metric === metric);
      if (mine.length === 0) continue;
      log(`\n${metric} (${METRICS[metric].what}):`);
      for (const h of mine) log(`  ${h.file}:${h.line}  ${h.value}`);
    }
  }

  if (update) {
    try {
      const next = lowerBaseline(counts, baseline);
      writeFileSync(opts.baselinePath, `${JSON.stringify(next, null, 2)}\n`);
      log(`Baseline written: ${opts.baselinePath}`);
      return 0;
    } catch (e) {
      error((e as Error).message);
      return 1;
    }
  }

  const cmp = compare(counts, baseline);
  for (const l of cmp.lowered) log(`can lower baseline: metric ${l.metric} -> ${l.count}`);
  if (cmp.missing.length > 0) {
    error(`Baseline has no entry for: ${cmp.missing.join(', ')}. Run with --update to add it.`);
    return 1;
  }
  if (cmp.raised.length === 0) return 0;

  const changed = changedFiles(opts.root);
  for (const r of cmp.raised) {
    const meta = METRICS[r.metric];
    error(`\nDesign ratchet: ${r.metric} rose ${r.baseline} -> ${r.count} (${meta.what}).`);
    error(`  Use instead: ${meta.fix}`);
    const mine = hits.filter(
      (h) => h.metric === r.metric && (changed === null || changed.has(h.file)),
    );
    for (const h of mine) error(`  ${h.file}:${h.line}  ${h.value}`);
  }
  error('\nNever raise the baseline; fix the code (CLAUDE.md Layout rules).');
  return 1;
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  process.exitCode = run(process.argv.slice(2), {
    root,
    baselinePath: join(root, 'scripts', 'design-ratchet.baseline.json'),
  });
}
