import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkKeyframes } from '@/lib/motion/run';
import * as moves from '@/lib/motion/moves';

// Motion: only src/lib/motion moves (docs/motion.md). Outside it no file
// carries its own transition or animation (Tailwind transition-*, animate-*,
// duration-*, raw transition/animation values, @keyframes, Web Animations
// calls), nothing animates opacity, and every overlay is built on a shared
// piece or a motion-module move. Modelled on lighting-rules.test.ts.
const SRC = fileURLToPath(new URL('../', import.meta.url));

// Exact paths, each with its reason.
const ALLOW: Record<string, string> = {
  'components/dev/MarksPanel.tsx': 'dev only: the marks panel behind a dev flag',
  'components/chat/PaintLog.tsx': 'dev only: the ?paintlog=1 panel',
  'components/home/Chrome.tsx': 'home/ marketing page chrome: its own bundle, not the app',
};
// el.style.transition set by hand: [file]: [text on the line, reason].
// (The swipe follow moved into src/lib/motion/swipe.ts; nothing is allowed now.)
const STYLE_TRANSITION_ALLOW: Record<string, readonly [string, string]> = {};
const ALLOW_DIRS = [
  // The marketing page (signed-out home) ships as its own bundle and keeps its own look.
  'components/home/',
  // Developer-only tools behind dev flags.
  'components/dev/',
];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(tsx?|css)$/.test(name) ? [path] : [];
  });
}

const FILES = sources(SRC)
  .map((path) => relative(SRC, path).split(sep).join('/'))
  .filter((rel) => !rel.startsWith('lib/motion/') && !rel.startsWith('server/'))
  .filter(
    (rel) =>
      !/\.test\.tsx?$/.test(rel) && !rel.includes('__tests__/') && !rel.includes('__snapshots__/'),
  )
  .filter((rel) => !(rel in ALLOW) && !ALLOW_DIRS.some((dir) => rel.startsWith(dir)))
  .map((rel) => ({ rel, src: readFileSync(join(SRC, rel), 'utf8') }));

function hits(re: RegExp, only: (rel: string) => boolean = () => true): string[] {
  const out: string[] = [];
  for (const { rel, src } of FILES) {
    if (!only(rel)) continue;
    src.split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      if (re.test(line)) out.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  return out;
}

const isTs = (rel: string): boolean => /\.tsx?$/.test(rel);
const isCss = (rel: string): boolean => rel.endsWith('.css');
// A class token inside a string: preceded by a quote, backtick, space or a
// variant colon, followed by a space, quote or backtick.
const CLASS = (body: string): RegExp =>
  new RegExp(`(["'\`]|["'\`][^"'\`]*[\\s:])(${body})(?=[\\s"'\`])`);

describe('motion rules', () => {
  it('no transition-* or animate-* class outside src/lib/motion', () => {
    expect(hits(CLASS('transition(-[\\w[\\]().,%-]+)?|animate-[\\w[\\]-]+'), isTs)).toEqual([]);
  });

  it('no duration-* or motion-reduce: utility outside src/lib/motion', () => {
    expect(hits(CLASS('duration-[\\w[\\]-]+|motion-(reduce|safe):[\\w[\\]:-]+'), isTs)).toEqual([]);
  });

  it('no raw transition or animation values in code', () => {
    expect(
      hits(
        /\b(transition|animation)(Property|Duration|TimingFunction|Delay|Name)?\s*:\s*['"`]/,
        isTs,
      ),
    ).toEqual([]);
    expect(hits(/\[(transition|animation)[\w-]*:/, isTs)).toEqual([]);
  });

  it('no Web Animations call outside the module', () => {
    expect(hits(/\.animate\(\s*\[/, isTs)).toEqual([]);
  });

  it('no @keyframes, transition or animation in stylesheets outside the module', () => {
    expect(hits(/@keyframes|^\s*(transition|animation)[\w-]*\s*:/, isCss)).toEqual([]);
  });

  it('no opacity in any transition, animation or keyframe (motion.css included)', () => {
    const css = readFileSync(join(SRC, 'lib/motion/motion.css'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    for (const block of css.split('}')) {
      if (/transition|@keyframes|animation/.test(block)) expect(block).not.toMatch(/opacity/);
    }
    expect(hits(/animate-pulse|transition-opacity|\bopacity\b[^;\n]*\btransition\b/)).toEqual([]);
  });

  it('every overlay is built on a shared piece or a motion-module move', () => {
    const SHARED = new Set([
      'components/ui/Sheet.tsx',
      'components/ui/ConfirmDialog.tsx',
      'components/ui/ActionMenu.tsx',
      'components/shell/MenuPopover.tsx',
      'components/ui/SidePanel.tsx',
      'components/ui/Backdrop.tsx',
    ]);
    const bad = FILES.filter(({ rel }) => isTs(rel) && !SHARED.has(rel))
      .filter(({ src }) => /\srole=["']dialog["']|\saria-modal[=\s]|\bfixed inset-0\b/.test(src))
      .filter(({ src }) => {
        const usesShared =
          /from '@\/components\/ui\/(Sheet|ConfirmDialog|ActionMenu|SidePanel|Backdrop)'/.test(
            src,
          ) || /from '@\/components\/shell\/MenuPopover'/.test(src);
        const usesMove = /from '@\/lib\/motion'/.test(src);
        return !usesShared && !usesMove;
      })
      .map(({ rel }) => rel);
    expect(bad).toEqual([]);
  });

  it('every move declares an axis', () => {
    const specs = Object.entries(moves).filter(
      ([, value]) => typeof value === 'object' && value !== null && 'move' in value,
    );
    expect(specs.length).toBeGreaterThanOrEqual(9);
    for (const [name, spec] of specs) {
      const axis = (spec as { axis?: readonly string[] }).axis;
      expect(Array.isArray(axis) && axis.length > 0, name).toBe(true);
    }
  });

  it('the player refuses opacity and properties outside the axis', () => {
    expect(() => checkKeyframes(moves.ITEM_IN, [{ opacity: 0 }, { opacity: 1 }])).toThrow(
      /opacity/,
    );
    expect(() => checkKeyframes(moves.ITEM_IN, [{ clipPath: 'inset(0)' }])).toThrow(/axis/);
    expect(() =>
      checkKeyframes(moves.ITEM_IN, [{ transform: 'translateY(8px)' }, { transform: 'none' }]),
    ).not.toThrow();
  });

  it('no hand-set transition on an element (el.style.transition = ...) outside the module', () => {
    // Clearing ('' / 'none') or restoring a saved value is fine; setting a
    // move by hand is not (the nine moves live in src/lib/motion).
    const set = hits(
      /\.style\.transition\s*=(?!=)|\.style\.setProperty\(\s*['"]transition['"]/,
      isTs,
    ).filter((hit) => {
      const rhs = /\.style\.transition\s*=\s*([^;]+)/.exec(hit)?.[1]?.trim() ?? '';
      if (/^(['"`])(none)?\1$/.test(rhs)) return false;
      // A saved value put back (prev.transition, saved).
      if (/^[\w.]+$/.test(rhs)) return false;
      return true;
    });
    const allowed = (hit: string): boolean =>
      Object.entries(STYLE_TRANSITION_ALLOW).some(
        ([rel, needle]) => hit.startsWith(`${rel}:`) && hit.includes(needle[0]),
      );
    expect(set.filter((hit) => !allowed(hit))).toEqual([]);
  });

  it('menus and popovers grow with --ease-enter; pop() keeps --ease-pop', () => {
    const movesSrc = readFileSync(join(SRC, 'lib/motion/moves.ts'), 'utf8');
    const body = (name: string): string => {
      const at = movesSrc.indexOf(`export function ${name}(`);
      const open = movesSrc.indexOf('{', movesSrc.indexOf(')', at));
      return movesSrc.slice(open, movesSrc.indexOf('\n}', open));
    };
    expect(body('growFromTrigger')).toContain('EASE.enter');
    expect(body('growFromTrigger')).not.toContain('EASE.pop');
    expect(body('pop')).toContain('EASE.pop');
  });

  it('a theme switch turns every transition off for two frames (motion.css)', () => {
    const css = readFileSync(join(SRC, 'lib/motion/motion.css'), 'utf8').replace(/\s+/g, ' ');
    expect(css).toMatch(/html\.theme-switching \*[^{]*\{ transition: none !important; \}/);
    const theme = readFileSync(join(SRC, 'lib/theme.ts'), 'utf8');
    expect(theme).toContain('theme-switching');
    expect(theme).toContain('requestAnimationFrame');
  });

  it('the allowlist names files that exist', () => {
    for (const rel of [...Object.keys(ALLOW), ...Object.keys(STYLE_TRANSITION_ALLOW)]) {
      expect(() => statSync(join(SRC, rel)), rel).not.toThrow();
    }
    for (const [rel, [needle, reason]] of Object.entries(STYLE_TRANSITION_ALLOW)) {
      expect(readFileSync(join(SRC, rel), 'utf8'), rel).toContain(needle);
      expect(reason.length, rel).toBeGreaterThan(10);
    }
  });

  it('index.css keeps no keyframes of its own and imports the module stylesheet', () => {
    const css = readFileSync(join(SRC, 'index.css'), 'utf8');
    expect(css).not.toMatch(/@keyframes/);
    expect(css).toContain("@import './lib/motion/motion.css';");
  });

  it('the search focus glide is the module glide, X only, --dur-base', () => {
    expect(moves.GLIDE_ASIDE).toEqual({ move: 'glide', axis: ['x'] });
    expect(() =>
      checkKeyframes(moves.GLIDE_ASIDE, [
        { transform: 'translateX(0)' },
        { transform: moves.GLIDE_ASIDE_X },
      ]),
    ).not.toThrow();
    const motion = readFileSync(join(SRC, 'lib/motion/moves.ts'), 'utf8');
    const body = motion.slice(motion.indexOf('export function glideAside'));
    expect(body.slice(0, body.indexOf('\n}\n'))).toContain('duration: DUR_BASE_MS');
    // Decision B (7 Nov): no screen search row is left to glide aside.
    const header = readFileSync(join(SRC, 'components/shell/SectionHeader.tsx'), 'utf8');
    expect(header).not.toContain('glideAside');
  });
});
