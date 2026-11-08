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
      // Comments describe the light; only code carries classes.
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      const clean = line.split(SPOTLIGHT).join('');
      if (re.test(clean)) out.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  return out;
}

// States (hover, press, disabled): hover and press stack an overlay on the
// light (lit-hover / --hover-fill / --press-fill), disabled is solid fg-3 ink;
// neither swaps to a flat panel fill nor fades. Files skipped by those rules,
// each with its reason.
const STATE_EXEMPT: ReadonlyMap<string, string> = new Map([
  ['ui/ImageLightbox.tsx', 'media viewer: controls over a full-screen image keep the overlay look'],
  ['ui/FileViewer.tsx', 'media viewer: controls over a full-screen file keep the overlay look'],
  ['ui/PhotoViewer.tsx', 'media viewer: controls over a full-screen person photo'],
  ['pages/pcs/PostLightbox.tsx', 'media viewer: controls over the post lightbox media'],
  ['pages/assets/AssetLightbox.tsx', 'media viewer: controls over the asset lightbox media'],
  ['dev/MarksPanel.tsx', 'dev only: the marks panel behind a dev flag'],
  ['chat/PaintLog.tsx', 'dev only: the ?paintlog=1 panel'],
]);
const stateExempt = (rel: string): boolean =>
  STATE_EXEMPT.has(rel) || rel.startsWith('ui/viewers/');
// opacity on media (an image or video, its object-fit box) or on a motion-module
// element (mv-*: the move owns it) is not dimmed text.
// A blurred backdrop of the media itself (blur-xl) is media too.
const MEDIA_LINE =
  /<img\b|<video\b|\bobject-(cover|contain)\b|\bblur-(sm|md|lg|xl|2xl|3xl)\b|\bmv-[a-z-]+/;
// [file, text on the line, reason]: opacity that is not dimmed copy.
const OPACITY_ALLOW: readonly (readonly [string, string, string])[] = [
  [
    'chat/FileBubble.tsx',
    "props.dimmed && 'opacity-80'",
    'the file image under its swap (media, not text)',
  ],
  [
    'pages/pcs/checkpoint-controls.tsx',
    "'opacity-100' : 'opacity-60'",
    'the tick glyph inside the checkpoint box (an icon, not copy), full when marked',
  ],
  [
    'chat/VoiceNote.tsx',
    "'opacity-[.45]'",
    'the play glyph of a voice note that cannot play yet (an icon, not copy); the thread shows Not sent per message',
  ],
  [
    'chat/FileBubble.tsx',
    "props.dimmed ? 'opacity-80'",
    'the decoded image under its swap (media, not text)',
  ],
  [
    'pages/create/FileTiles.tsx',
    "'opacity-40'",
    'uploading / failed thumbnail: opacity on the image box only; ui/UploadRing or UploadRetry on it reads the state',
  ],
  [
    'ui/UploadRing.tsx',
    'bg-overlay opacity-60',
    'the dim layer over an uploading thumbnail (a media overlay, no text)',
  ],
  [
    'chat/ReadingLayer.tsx',
    "props.dimmed === true && 'opacity-50'",
    'a person avatar dimmed in the read sheet (a picture, not copy)',
  ],
];

const DEFINED = new Set([...CSS.matchAll(/\.(lit-[a-z-]+)/g)].map((m) => m[1]));

/** The theme block that opens at `sel {` (the first match: :root, then \n.dark). */
const themeBlockOf = (sel: string): string => {
  const start = CSS.indexOf(`${sel} {`);
  return CSS.slice(start, CSS.indexOf('\n}', start));
};
/**
 * The FLAT LOOK block (7 Nov 2026): ':root,\n.dark { ... }' after the .dark
 * block. Its values win over both themes (same specificity, later in source).
 */
const FLAT_BLOCK = (() => {
  const start = CSS.search(/:root,\s*\.dark\s*\{/);
  return start < 0 ? '' : CSS.slice(start, CSS.indexOf('\n}', start));
})();
/** The token names the flat block sets. */
const FLAT_TOKENS = new Set([...FLAT_BLOCK.matchAll(/(--lit-[\w-]+):/g)].map((m) => m[1] ?? ''));
/** A token's value inside one block, whitespace folded. */
const tokenIn = (body: string, name: string): string =>
  (new RegExp(`--${name}:([^;]+);`).exec(body)?.[1] ?? '').replace(/\s+/g, ' ').trim();
const src = (rel: string) => FILES.find((f) => f.rel === rel)?.src ?? '';

describe('lighting rules', () => {
  it('no Tailwind shadow or drop-shadow class on a call site', () => {
    expect(
      hits(
        /(^|[\s"'`:])(shadow|shadow-(sm|md|lg|xl|2xl|inner|none)|drop-shadow(-[\w[\]().-]+)?)(?=[\s"'`]|$)/,
      ),
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
      for (const m of s.matchAll(/(?<![\w-])(lit-[a-z]+(?:-[a-z]+)*)(?![\w-])/g)) used.add(m[0]);
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
      'lit-dock-joined',
      'lit-btn-primary',
      'lit-btn-success',
      'lit-btn-danger',
      'lit-btn-secondary',
      'lit-chip',
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
      'lit-strip',
    ]) {
      expect(DEFINED.has(c), c).toBe(true);
      // lit-card-muted reuses the --lit-card shadow over its own panel-2 fill.
      const token = `--${c === 'lit-card-muted' ? 'lit-muted-shine' : c}:`;
      // Once in :root and once in .dark; a third time only in the FLAT LOOK block.
      expect(themeBlockOf(':root').split(token).length - 1, `:root ${token}`).toBe(1);
      expect(themeBlockOf('\n.dark').split(token).length - 1, `.dark ${token}`).toBe(1);
      const flat = FLAT_BLOCK.split(token).length - 1;
      expect(CSS.split(token).length - 1, token).toBe(2 + flat);
    }
    expect(CSS).not.toMatch(/transition[^;]*box-shadow/);
  });

  it('lit-dock-joined (the composer bar under the open tray) draws no top edge in either theme', () => {
    const block = (sel: string): string => {
      const start = CSS.indexOf(`${sel} {`);
      return CSS.slice(start, CSS.indexOf('\n}', start));
    };
    for (const sel of [':root', '\n.dark']) {
      const value = (/--lit-dock-joined:([^;]+);/.exec(block(sel))?.[1] ?? '').replace(/\s+/g, ' ');
      expect(value.trim(), sel.trim()).not.toBe('');
      // No top inset highlight, no top line, no upward (negative y) shade.
      expect(value, sel.trim()).not.toMatch(/inset 0 1px/);
      expect(value, sel.trim()).not.toMatch(/(^|,)\s*-?\d+(\.\d+)?(px)? -\d/);
      // The flat block leaves lit-dock-joined alone.
      expect(FLAT_TOKENS.has('--lit-dock-joined')).toBe(false);
    }
    // The dock itself keeps its top edge: flat, the --border hairline above it.
    expect(tokenIn(FLAT_BLOCK, 'lit-dock')).toBe('0 -1px 0 var(--border)');
    const flat = CSS.replace(/\s+/g, ' ');
    const own = flat.split('.lit-dock-joined {')[1]?.split('}')[0] ?? '';
    expect(own).toContain('box-shadow: var(--lit-dock-joined)');
    expect(own).toContain('border-top-color: transparent');
  });

  it('the + tray is the top of the writing box: no shadow of its own; the bar keeps one lit-dock', () => {
    const composer = src('chat/Composer.tsx');
    // 8 Nov 2026: the tray opens inside the box, so the bar never joins.
    expect(composer).not.toContain('lit-dock-joined');
    expect(composer).toContain('border-t bg-panel px-3 py-2 lit-dock');
    const tray = src('chat/ComposerTray.tsx');
    // The boxed tray: a hairline under the tiles, the box's fill, no light.
    expect(tray).toMatch(/data-tray-boxed=""[\s\S]*?className="border-b pb-2 pt-2"/);
    // Outside a writing box the floating tray keeps lit-dock.
    expect(tray).toMatch(/data-tray=""[\s\S]*?className="[^"]*\blit-dock\b(?!-)/);
  });

  it('the old shadow tokens are gone; the spotlight stays', () => {
    expect(CSS).not.toMatch(/--shadow-card|--strip-shadow|--shadow-panel-left/);
    expect(CSS).toContain('--shadow-spotlight:');
  });

  it('selected days keep the solid accent (the lit-pill class, flat by token), never a glow or tint', () => {
    const picker = src('ui/DatePicker.tsx');
    expect(picker).toContain("'bg-accent text-accent-fg lit-pill'");
    expect(src('pages/pipeline/PipelineDateRangeCalendar.tsx')).toContain(
      "'bg-accent font-semibold text-accent-fg lit-pill'",
    );
    expect(src('chat/PlanDayPickerSheet.tsx')).toContain(
      "'border-transparent bg-accent text-accent-fg hover:bg-accent lit-pill'",
    );
    for (const rel of [
      'ui/DatePicker.tsx',
      'pages/pipeline/PipelineDateRangeCalendar.tsx',
      'chat/PlanDayPickerSheet.tsx',
    ]) {
      expect(src(rel), rel).not.toContain('lit-chip-selected');
    }
  });

  it('every single-choice pick is the ink outline (flat look), switched instantly; idle options rest on the hairline', () => {
    for (const rel of [
      'shell/Tabs.tsx',
      'support/BookCallSheet.tsx',
      'shell/WorkspaceSwitcher.tsx',
      'onboarding/OnboardingFlow.tsx',
      'cockpit/Cockpit.tsx',
      'ui/viewers/SheetViewer.tsx',
      'chat/ReadingLayer.tsx',
      'chat/EmojiPicker.tsx',
    ]) {
      const code = src(rel);
      expect(code, rel).not.toContain('selectionSlideRef');
      expect(code, rel).not.toContain('data-fill-slide');
      // The pick: the fg line and fg ink, no fill.
      expect(code, rel).toMatch(/border-fg[^'"]*text-fg\b/);
      expect(code, rel).not.toMatch(/bg-accent[^'"]*text-accent-fg[^'"]*lit-pill/);
    }
    for (const rel of [
      'shell/Tabs.tsx',
      'support/BookCallSheet.tsx',
      'shell/WorkspaceSwitcher.tsx',
      'onboarding/OnboardingFlow.tsx',
      'cockpit/Cockpit.tsx',
      'ui/viewers/SheetViewer.tsx',
      'chat/ReadingLayer.tsx',
    ]) {
      const code = src(rel);
      // Idle: the --border hairline and fg-2 ink; never the old grey well.
      expect(code, rel).toMatch(/border-border[^'"]*text-fg-2/);
      expect(code, rel).not.toContain('bg-panel-3 text-fg lit-well-soft');
      expect(code, rel).not.toContain('lit-chip');
    }
    // The day picker keeps the ink fill for a picked day (a date, not a choice row).
    const days = src('chat/PlanDayPickerSheet.tsx');
    expect(days).toMatch(/bg-accent[^'"]*text-accent-fg[^'"]*lit-pill/);
    expect(days).not.toContain('selectionSlideRef');
  });

  it('hover keeps the light: the hover rules stack --hover-fill over --lit-bg', () => {
    const flat = CSS.replace(/\s+/g, ' ');
    expect(flat).toContain('@media (hover: hover) {');
    const hover = /@media \(hover: hover\) \{([^{}]*)\{([^}]*)\}/.exec(flat);
    const selectors = hover?.[1] ?? '';
    const body = hover?.[2] ?? '';
    for (const sel of [
      '.lit-btn-secondary:hover',
      '.lit-chip:hover',
      '.lit-selected:hover',
      '.lit-hover:hover',
      ":is(button, a, [role='button']).lit-card:hover",
      ":is(button, a, [role='button']).lit-card-muted:hover",
    ]) {
      expect(selectors, sel).toContain(sel);
    }
    expect(body).toContain('linear-gradient(var(--hover-fill), var(--hover-fill))');
    expect(body).toContain('var(--lit-bg');
    // Press stacks --press-fill the same way.
    const press = /\.lit-chip:active,[^{]*\{([^}]*)\}/.exec(flat)?.[1] ?? '';
    expect(press).toContain('linear-gradient(var(--press-fill), var(--press-fill))');
    expect(press).toContain('var(--lit-bg');
    // The gradients are background-image, so a call site's bg-* still applies underneath.
    for (const c of ['lit-card', 'lit-chip', 'lit-btn-secondary']) {
      // The last match is the class's own rule (the edge rule lists it first).
      const parts = flat.split(`.${c} {`);
      const own = parts[parts.length - 1]?.split('}')[0] ?? '';
      expect(own, c).toContain('background-image:');
      expect(own, c).toContain('--lit-bg:');
      expect(own, c).not.toMatch(/(^|[ ;])background:/);
    }
  });

  it('no hover or press rule in index.css drops the light (background-image: none)', () => {
    const flat = CSS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');
    const offenders: string[] = [];
    for (const m of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = (m[1] ?? '').trim();
      const body = m[2] ?? '';
      if (!/:(hover|active)\b/.test(selector)) continue;
      if (/background-image:\s*none/.test(body) || /opacity\s*:/.test(body)) {
        offenders.push(selector);
      }
    }
    expect(offenders).toEqual([]);
    // The retired opt-out for div cards with their own hover:bg-* is gone:
    // those cards take lit-hover instead.
    expect(flat).not.toContain("[class*='hover:bg-']");
  });

  it('plan chips are the shared Chip (full ink idle)', () => {
    const tab = src('pages/PlanTabPage.tsx');
    expect(tab).toContain('<Chip');
    expect(tab).not.toMatch(/variant="ghost"[^>]*data-plan-tab-when/);
  });

  it('hover is the --hover-fill overlay (lit-hover), never a flat hover:bg-panel-2/3 swap', () => {
    expect(hits(/(^|[\s"'`:])hover:bg-panel-[23](?=[\s"'`/]|$)/, stateExempt)).toEqual([]);
  });

  it('no hover:opacity-* (success and danger hover is the --hover-fill overlay)', () => {
    expect(hits(/(^|[\s"'`:])hover:opacity-[\w[\]().]+/, stateExempt)).toEqual([]);
  });

  it('disabled is never opacity (text-fg-3 solid; primary bg-fg-3)', () => {
    expect(hits(/(^|[\s"'`:])disabled:opacity-(?!100\b)[\w[\]().]+/, stateExempt)).toEqual([]);
  });

  it('no dimmed text: opacity-N only on media, reveals (0/100) and the allowlist', () => {
    const allowed = (hit: string): boolean =>
      MEDIA_LINE.test(hit) ||
      OPACITY_ALLOW.some(([rel, needle]) => hit.startsWith(`${rel}:`) && hit.includes(needle));
    const offenders = hits(
      /(^|[\s"'`:])opacity-(?!0\b|100\b)(\d+|\[[^\]]+\])(?=[\s"'`]|$)/,
      stateExempt,
    ).filter((hit) => !allowed(hit));
    expect(offenders).toEqual([]);
  });

  it('every opacity allowlist entry still matches a line and gives a reason', () => {
    for (const [rel, needle, reason] of OPACITY_ALLOW) {
      expect(src(rel), rel).toContain(needle);
      expect(reason.length, rel).toBeGreaterThan(10);
    }
    for (const [rel, reason] of STATE_EXEMPT) {
      expect(
        FILES.some((f) => f.rel === rel),
        rel,
      ).toBe(true);
      expect(reason.length, rel).toBeGreaterThan(10);
    }
  });

  it('the switch knob is lighter than its off track in both themes (higher is lighter)', () => {
    const hex = (body: string, name: string): string =>
      new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6});`).exec(body)?.[1] ?? '';
    const lum = (h: string): number => {
      const c = (i: number): number => {
        const s = parseInt(h.slice(i, i + 2), 16) / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * c(1) + 0.7152 * c(3) + 0.0722 * c(5);
    };
    const themeBlock = (sel: string): string => {
      const start = CSS.indexOf(`${sel} {`);
      return CSS.slice(start, CSS.indexOf('\n}', start));
    };
    for (const sel of [':root', '\n.dark']) {
      const body = themeBlock(sel);
      const knob = hex(body, 'knob');
      const track = hex(body, 'panel-2');
      expect(knob, `${sel.trim()} --knob`).not.toBe('');
      expect(track, `${sel.trim()} --panel-2`).not.toBe('');
      expect(lum(knob), sel.trim()).toBeGreaterThan(lum(track));
    }
  });

  it('dark floating tokens carry a bottom rim dimmer than the top edge; light has none; in-content tokens are flat', () => {
    const light = themeBlockOf(':root');
    const dark = themeBlockOf('\n.dark');
    // Floating layers (sheets, menus, toasts) keep their light: the flat block never touches them.
    for (const name of ['lit-float', 'lit-overlay']) {
      expect(FLAT_TOKENS.has(`--${name}`), name).toBe(false);
      const d = tokenIn(dark, name);
      expect(d, name).toContain('inset 0 -1px 0');
      // Top edge: a white highlight (#fff / #ffffff is full strength).
      const topHit = /inset 0 1px 0 (?:rgba\(255, 255, 255, ([\d.]+)\)|#fff(?:fff)?\b)/.exec(d);
      const top = topHit === null ? Number.NaN : Number(topHit[1] ?? 1);
      const darkRim = /inset 0 -1px 0 rgba\(0, 0, 0, [\d.]+\)/.test(d);
      const rim = darkRim
        ? 0
        : Number(/inset 0 -1px 0 rgba\(255, 255, 255, ([\d.]+)\)/.exec(d)?.[1]);
      expect(rim, name).toBeLessThan(top);
      expect(tokenIn(light, name), name).not.toContain('inset 0 -1px 0');
    }
    // In-content surfaces: the flat block sets them to no shadow in both themes.
    for (const name of [
      'lit-raised',
      'lit-card',
      'lit-btn-primary',
      'lit-btn-success',
      'lit-btn-danger',
      'lit-btn-secondary',
      'lit-chip',
      'lit-bubble-own',
      'lit-bubble-other',
    ]) {
      expect(tokenIn(FLAT_BLOCK, name), name).toBe('0 0 #0000');
    }
  });

  it('every token has at most one soft (blurred) outer shadow (speed)', () => {
    // A blurred layer is the costly paint; dozens of cards double it. Insets
    // and 0 0 0 Npx rings (no blur) do not count.
    const block = (sel: string): string => {
      const start = CSS.indexOf(`${sel} {`);
      return CSS.slice(start, CSS.indexOf('\n}', start));
    };
    const layers = (v: string): string[] => {
      const out: string[] = [];
      let depth = 0;
      let cur = '';
      for (const ch of v) {
        if (ch === '(') depth += 1;
        if (ch === ')') depth -= 1;
        if (ch === ',' && depth === 0) {
          out.push(cur.trim());
          cur = '';
        } else cur += ch;
      }
      out.push(cur.trim());
      return out;
    };
    const blurred = (layer: string): boolean => {
      if (layer.startsWith('inset') || layer.startsWith('var(')) return false;
      const parts = layer
        .replace(/rgba?\([^)]*\)|#\w+|var\([^)]*\)/g, '')
        .trim()
        .split(/\s+/)
        .map((p) => Number.parseFloat(p));
      return parts.length >= 3 && (parts[2] ?? 0) > 0;
    };
    const offenders: string[] = [];
    for (const sel of [':root', '\n.dark']) {
      for (const m of block(sel).matchAll(/\n {2}(--lit-[\w-]+):([^;]+);/g)) {
        const value = (m[2] ?? '').replace(/\s+/g, ' ').trim();
        if (/gradient|^#|^rgba|^var\(/.test(value)) continue;
        const soft = layers(value).filter(blurred).length;
        if (soft > 1) offenders.push(`${sel.trim()} ${m[1] ?? ''}: ${soft}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the shared primitives carry their lit class', () => {
    const button = src('ui/Button.tsx');
    for (const c of ['lit-btn-primary', 'lit-btn-secondary', 'lit-btn-success', 'lit-btn-danger']) {
      expect(button, c).toContain(c);
    }
    // Chips are the flat outline pill (7 Nov 2026): rest on the strong edge in
    // fg-2 (3:1 edge rule, 8 Nov 2026), the pick is the fg line in fg ink; no
    // fill, no lit-pill.
    const chip = src('ui/Chip.tsx');
    expect(chip).toContain("'border-border-strong text-fg-2'");
    expect(chip).not.toContain("'border-border text-fg-2'");
    expect(chip).toContain("'border-fg text-fg'");
    expect(chip).not.toContain('bg-accent text-accent-fg lit-pill');
    expect(chip).not.toContain('lit-well-soft');
    expect(src('ui/Input.tsx')).toContain('lit-well');
    expect(src('ui/Sheet.tsx')).toContain('lit-overlay');
    expect(src('ui/popover-classes.ts')).toContain('lit-overlay');
    // The phone dock is flat: the --border hairline on the panel, no lit height.
    const tabs = src('shell/BottomTabs.tsx');
    expect(tabs).toContain('rounded-full border border-border bg-panel');
    expect(tabs).not.toContain('lit-raised');
    expect(tabs).not.toContain('lit-pill');
    expect(src('ui/toast/Toast.tsx')).toContain('lit-float');
    // The dark undo strip takes its own faint top line, not lit-float's
    // .95 white hairline.
    expect(src('ui/toast/UndoStrip.tsx')).toContain('lit-strip');
  });

  it('index.css defines the state and modifier classes', () => {
    for (const c of ['lit-hover', 'lit-press', 'lit-strip', 'lit-page', 'lit-focus-inset']) {
      expect(DEFINED.has(c), c).toBe(true);
    }
  });
});
