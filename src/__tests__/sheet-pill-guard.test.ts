import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Rule (CLAUDE.md Design rules, 8 Nov 2026): "Sheet primary action: Button
// shape=pill, right-aligned, auto width. Clear: outlined pill."
// Source scan: every variant="primary" Button in a Sheet footer (and every
// SheetActions primary) carries shape="pill" and is never full width; a single
// primary sits in a full-width justify-end wrapper (the footer is a flex row);
// every "Clear" text Button is the shared ClearButton (ui/Button), except the
// frozen list below, which may only shrink.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SRC = join(ROOT, 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === '__tests__') continue;
      walk(path, out);
    } else if (name.endsWith('.tsx') && !name.includes('.test.')) {
      out.push(path);
    }
  }
  return out;
}

/** The balanced {...} block that starts at `open` (the index of its '{'). Pure. */
function braceBlock(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open);
}

function blocksAfter(src: string, prop: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`\\b${prop}=\\{`, 'g');
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    out.push(braceBlock(src, m.index + m[0].length - 1));
  }
  return out;
}

const BUTTON = /<Button\b[\s\S]*?<\/Button>/g;
const FILES = walk(SRC).map((path) => ({
  rel: relative(ROOT, path),
  src: readFileSync(path, 'utf8'),
}));

/** Ghost "Clear" Buttons that predate the rule; the list may only shrink. */
const GHOST_CLEAR_KEEP = new Set([
  'src/components/chat/MessageActionMenu.tsx',
  'src/components/chat/PaintLog.tsx',
  'src/components/chat/PlanItemScreen.tsx',
  'src/components/chat/PlanScreen.tsx',
  'src/components/dev/MarksPanel.tsx',
  'src/components/pages/pcs/PostDetailsSheet.tsx',
  'src/components/pages/pipeline/PipelineDateRangeCalendar.tsx',
  'src/components/pages/plan-tab/BankList.tsx',
  'src/components/shell/CommandPalette.tsx',
  'src/components/storage/StorageWarningBanner.tsx',
]);

describe('sheet primary action is the black pill', () => {
  it('every variant="primary" Button in a Sheet footer has shape="pill" and no full width', () => {
    const bad: string[] = [];
    for (const { rel, src } of FILES) {
      for (const block of [...blocksAfter(src, 'footer'), ...blocksAfter(src, 'primary')]) {
        for (const tag of block.match(BUTTON) ?? []) {
          if (!tag.includes('variant="primary"')) continue;
          if (!tag.includes('shape="pill"')) bad.push(`${rel}: no shape="pill"`);
          if (/className="[^"]*\bw-full\b/.test(tag)) bad.push(`${rel}: full width`);
          if (/className="[^"]*\bml-auto\b/.test(tag))
            bad.push(`${rel}: ml-auto, use a justify-end wrapper`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it.each([
    ['src/components/chat/PostPicker.tsx', 'data-picker-done'],
    ['src/components/pages/plan-tab/BankPickSheet.tsx', 'data-plan-from-bank-done'],
    ['src/components/pages/plan-tab/BankFilterSheet.tsx', 'data-bank-filter-done'],
    ['src/components/chat/PlanDayPickerSheet.tsx', 'data-plan-dates-save'],
    ['src/components/pages/assets/AssetInUseSheet.tsx', 'data-asset-in-use-ok'],
    ['src/components/pages/pcs/PostDetailsSheet.tsx', 'data-details-done'],
  ])('%s: the single primary (%s) sits right, in a full-width justify-end wrapper', (rel, mark) => {
    const src = FILES.find((f) => f.rel === rel)?.src ?? '';
    const at = src.indexOf(mark);
    expect(at).toBeGreaterThan(-1);
    const before = src.slice(Math.max(0, at - 400), at);
    const wrapper = before.lastIndexOf('<div');
    expect(wrapper).toBeGreaterThan(-1);
    const wrapperTag = before.slice(wrapper, before.indexOf('>', wrapper) + 1);
    expect(wrapperTag).toContain('w-full');
    expect(wrapperTag).toContain('justify-end');
    const tag = src.slice(src.lastIndexOf('<Button', at), src.indexOf('>', at) + 1);
    expect(tag).toContain('shape="pill"');
    expect(tag).toContain('variant="primary"');
  });

  it('DatePicker Done is the black pill', () => {
    const src = FILES.find((f) => f.rel === 'src/components/ui/DatePicker.tsx')?.src ?? '';
    const at = src.indexOf('data-date-done');
    const tag = src.slice(src.lastIndexOf('<Button', at), src.indexOf('>', at) + 1);
    expect(tag).toContain('variant="primary"');
    expect(tag).toContain('shape="pill"');
  });
});

describe('Clear is the outlined pill', () => {
  it('no new ghost "Clear" text Button: Clear is ui/Button ClearButton', () => {
    const offenders = FILES.filter(({ src }) =>
      (src.match(BUTTON) ?? []).some((tag) => />\s*Clear\s*<\/Button>$/.test(tag)),
    ).map((f) => f.rel);
    expect(offenders.filter((rel) => !GHOST_CLEAR_KEEP.has(rel))).toEqual([]);
  });

  it('the keep list only shrinks: every kept file still has a ghost Clear', () => {
    for (const rel of GHOST_CLEAR_KEEP) {
      const src = FILES.find((f) => f.rel === rel)?.src ?? '';
      expect((src.match(BUTTON) ?? []).some((tag) => />\s*Clear\s*<\/Button>$/.test(tag))).toBe(
        true,
      );
    }
  });

  it.each([
    'src/components/ui/Chip.tsx',
    'src/components/ui/toast/Toast.tsx',
    'src/components/ui/LinkPreviewCard.tsx',
    'src/components/chat/Composer.tsx',
    'src/components/ui/DatePicker.tsx',
  ])('%s uses ClearButton', (rel) => {
    const src = FILES.find((f) => f.rel === rel)?.src ?? '';
    expect(src).toContain('<ClearButton');
  });

  it('ClearButton is ghost + pill with a 36 border-strong fg-2 face', () => {
    const src = FILES.find((f) => f.rel === 'src/components/ui/Button.tsx')?.src ?? '';
    expect(src).toMatch(/pill: 'rounded-full px-6'/);
    expect(src).toMatch(
      /CLEAR_PILL_FACE =\s*'inline-flex h-9 items-center rounded-full border border-border-strong px-4 text-fg-2'/,
    );
    expect(src).toContain('variant="ghost"');
    expect(src).toContain('shape="pill"');
  });
});
