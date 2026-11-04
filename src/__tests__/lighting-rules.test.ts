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
    'chat/PlanItemThread.tsx',
    "c.pending && 'opacity-70'",
    'a pending (clock) bubble: the whole bubble waits, matching the chat thread pending look; not disabled copy',
  ],
  [
    'chat/VoiceNote.tsx',
    "'opacity-[.45]'",
    'the play glyph of a voice note that cannot play yet (an icon, not copy); the thread shows Not sent per message',
  ],
  [
    'chat/FileBubble.tsx',
    "props.dimmed && 'opacity-80'",
    'the decoded image under its swap (media, not text)',
  ],
  [
    'pages/create/FileTiles.tsx',
    "'opacity-40'",
    'uploading / failed thumbnail: opacity on the image box only; its lit-badge label reads the state',
  ],
  [
    'pages/plan-tab/PlanCalendar.tsx',
    "props.lifted && 'opacity-40'",
    'the drag ghost left in place while its lifted copy floats (lit-float)',
  ],
  [
    'chat/UploadRing.tsx',
    'bg-overlay opacity-60',
    'the dim layer over an uploading thumbnail (a media overlay, no text)',
  ],
  [
    'chat/ReadingLayer.tsx',
    "props.dimmed === true && 'opacity-50'",
    'a person avatar dimmed in the read sheet (a picture, not copy)',
  ],
  [
    'chat/PlanScreen.tsx',
    "props.dimmed && 'opacity-25'",
    'the drag ghost left in place while its lifted row floats (data-plan-row-lifted)',
  ],
];

const DEFINED = new Set([...CSS.matchAll(/\.(lit-[a-z-]+)/g)].map((m) => m[1]));
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
      expect(CSS.split(token).length - 1, token).toBe(2);
    }
    expect(CSS).not.toMatch(/transition[^;]*box-shadow/);
  });

  it('the old shadow tokens are gone; the spotlight stays', () => {
    expect(CSS).not.toMatch(/--shadow-card|--strip-shadow|--shadow-panel-left/);
    expect(CSS).toContain('--shadow-spotlight:');
  });

  it('selected days keep the solid accent and take a pill light, never a glow or tint', () => {
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

  it('plan filter chips are the shared Chip (full ink idle)', () => {
    const cal = src('pages/plan-tab/PlanCalendar.tsx');
    expect(cal).toContain('<Chip');
    expect(cal).not.toMatch(/variant="ghost"[^>]*data-plan-tab-chip/);
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

  it('dark raised tokens carry a bottom rim dimmer than the top edge; light has none', () => {
    const block = (sel: string): string => {
      const start = CSS.indexOf(`${sel} {`);
      return CSS.slice(start, CSS.indexOf('\n}', start));
    };
    const value = (body: string, name: string): string =>
      (new RegExp(`--${name}:([^;]+);`).exec(body)?.[1] ?? '').replace(/\s+/g, ' ');
    const light = block(':root');
    const dark = block('\n.dark');
    for (const name of [
      'lit-raised',
      'lit-card',
      'lit-float',
      'lit-overlay',
      'lit-btn-primary',
      'lit-btn-success',
      'lit-btn-danger',
      'lit-btn-secondary',
      'lit-chip',
      'lit-bubble-own',
      'lit-bubble-other',
    ]) {
      const d = value(dark, name);
      expect(d, name).toContain('inset 0 -1px 0');
      // Top edge: a white highlight (#fff / #ffffff is full strength).
      const topHit = /inset 0 1px 0 (?:rgba\(255, 255, 255, ([\d.]+)\)|#fff(?:fff)?\b)/.exec(d);
      const top = topHit === null ? Number.NaN : Number(topHit[1] ?? 1);
      // Bottom rim: a fainter white, or a dark rim under a white fill (the
      // off-white primary button and own bubble), which is dimmer by definition.
      const darkRim = /inset 0 -1px 0 rgba\(0, 0, 0, [\d.]+\)/.test(d);
      const rim = darkRim
        ? 0
        : Number(/inset 0 -1px 0 rgba\(255, 255, 255, ([\d.]+)\)/.exec(d)?.[1]);
      expect(rim, name).toBeLessThan(top);
      expect(value(light, name), name).not.toContain('inset 0 -1px 0');
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
    expect(src('ui/Chip.tsx')).toContain('lit-chip');
    expect(src('ui/Chip.tsx')).toContain('lit-selected');
    expect(src('ui/Input.tsx')).toContain('lit-well');
    expect(src('ui/Sheet.tsx')).toContain('lit-overlay');
    expect(src('ui/popover-classes.ts')).toContain('lit-overlay');
    expect(src('shell/BottomTabs.tsx')).toContain('lit-raised');
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
