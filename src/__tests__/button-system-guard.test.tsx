import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ClearButton } from '@/components/ui/Button';

// Buttons (CLAUDE.md "Buttons", approved 9 Nov 2026): three levels by job.
// MAIN (primary / success / danger) = solid fill, 8px rectangle; BUTTON
// (secondary) = soft grey, no border; TOOL (ghost / link) = no fill, no border.
// No lighting on any button, no pill text buttons, Clear is a Tool, Load more
// is ui/LoadMore, every Load more list pages by the fill count, and Chip is
// for filters and toggles only. Source scans; every hit prints as a path.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SRC = join(ROOT, 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === '__tests__') continue;
      walk(path, out);
    } else if (/\.(ts|tsx)$/.test(name) && !name.includes('.test.')) {
      out.push(path);
    }
  }
  return out;
}

const FILES = walk(SRC).map((path) => ({
  rel: relative(ROOT, path),
  src: readFileSync(path, 'utf8'),
}));
const TSX = FILES.filter((f) => f.rel.endsWith('.tsx'));
const read = (rel: string): string => FILES.find((f) => f.rel === rel)?.src ?? '';

/** Every opening tag of a JSX element (brace-aware, so arrow props do not end it). */
function openTags(src: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${name}\\b`, 'g');
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    let depth = 0;
    let i = m.index + m[0].length;
    for (; i < src.length; i += 1) {
      const c = src[i];
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      else if (c === '>' && depth === 0 && src[i - 1] !== '=') break;
    }
    out.push(src.slice(m.index, i + 1));
  }
  return out;
}

describe('1. no pill text buttons', () => {
  it('no <Button> carries shape="pill" (text buttons are the 8px rectangle; round is icon-only Main)', () => {
    const bad = TSX.filter(({ src }) =>
      openTags(src, 'Button').some((tag) => /\bshape=["{']+pill/.test(tag)),
    ).map((f) => f.rel);
    expect(bad, 'Remove shape="pill": Main is the rounded-lg rectangle').toEqual([]);
  });

  it('ButtonShape has no pill', () => {
    expect(read('src/components/ui/Button.tsx')).toMatch(
      /export type ButtonShape = 'default' \| 'round';/,
    );
  });
});

describe('2. no lighting on buttons', () => {
  it('no lit-btn-* class anywhere in src (Button.tsx included)', () => {
    const bad = FILES.filter(({ src }) => /\blit-btn-[a-z]+/.test(src)).map((f) => f.rel);
    expect(bad, 'Buttons carry no lighting: drop lit-btn-*').toEqual([]);
  });
});

describe('3. Load more is one part', () => {
  it('no "Show {n} more" / "Show more" copy', () => {
    const bad = TSX.filter(({ src }) =>
      /Show \{[^}]*\} more|Show \d+ more|Show more\b/.test(src),
    ).map((f) => f.rel);
    expect(bad, 'Use ui/LoadMore ("Load more", no count)').toEqual([]);
  });

  it('every "Load more" label renders through ui/LoadMore', () => {
    const bad = TSX.filter(
      ({ rel, src }) =>
        rel !== 'src/components/ui/LoadMore.tsx' &&
        (/>\s*Load more\s*</.test(src) ||
          /['"`]Load (more|\$\{[^}]*\} more|\d+ more)['"`]/.test(src)),
    ).map((f) => f.rel);
    expect(bad, 'Render <LoadMore busy onMore /> instead of a hand-built Load more').toEqual([]);
  });

  it('LoadMore is the Button level, left aligned, label exactly "Load more"', () => {
    const src = read('src/components/ui/LoadMore.tsx');
    expect(src).toContain("export const LOAD_MORE_LABEL = 'Load more';");
    expect(src).toContain('variant="secondary"');
    expect(src).toContain("cn('self-start', className)");
    expect(src).toContain('busy={busy}');
  });

  it.each([
    'src/components/pages/plan-tab/PlanTabList.tsx',
    'src/components/pages/BriefsPage.tsx',
    'src/components/pages/AssetsPage.tsx',
    'src/components/pages/NotificationsPage.tsx',
    'src/components/pages/pipeline/PipelineFeed.tsx',
    'src/components/chat/ChatInfoTabs.tsx',
    'src/components/chat/PostPicker.tsx',
    'src/components/chat/AssetPicker.tsx',
  ])('%s uses ui/LoadMore', (rel) => {
    expect(read(rel)).toContain('<LoadMore');
  });
});

describe('4. Load more lists page by the fill count', () => {
  // The retired fixed sizes: none may come back.
  it.each([
    ['src/lib/brief-list.ts', /BRIEF_LIST_PAGE_SIZE|limit\(\d+/],
    ['src/lib/assets.ts', /\bASSETS_PAGE_SIZE\b/],
    ['src/lib/chat/asset-picker.ts', /\bASSET_PAGE_SIZE\b|limit\(\d+/],
    ['src/lib/chat/channel-media.ts', /CHANNEL_MEDIA_PAGE_SIZE|limit\(\d+/],
    ['src/components/chat/post-picker.ts', /PICKER_PAGE_SIZE/],
    ['src/components/chat/PostPicker.tsx', /PICKER_PAGE_SIZE|limit: \d+|limit\(\d+/],
    ['src/lib/chat/plans.ts', /BANK_PAGE_SIZE|Math\.max\(12/],
  ])('%s has no fixed page size', (rel, banned) => {
    expect(read(rel), `${rel}: page by getFillCount()`).not.toMatch(banned);
  });

  it.each([
    ['src/lib/brief-list.ts', 'return getFillCount();'],
    ['src/lib/assets.ts', 'return getFillCount();'],
    ['src/lib/chat/channel-media.ts', 'return getFillCount();'],
    ['src/components/chat/PostPicker.tsx', 'return getFillCount();'],
    ['src/lib/chat/plans.ts', 'return getFillCount();'],
    ['src/lib/chat/asset-picker.ts', 'getTileFillCount('],
  ])('%s derives its page from the fill count', (rel, needle) => {
    expect(read(rel)).toContain(needle);
  });

  it('comments never page (10 Nov 2026): a post or brief reads every comment, no Load more', () => {
    const src = read('src/components/comments/Comments.tsx');
    expect(src).not.toContain('<LoadMore');
    expect(src).not.toContain('getFillCount');
    expect(src).toContain('export const COMMENTS_READ_PAGE = 1000;');
  });

  it('every Load more list decides through the one rule (src/lib/load-more-rule)', () => {
    for (const rel of [
      'src/components/pages/BriefsPage.tsx',
      'src/components/pages/AssetsPage.tsx',
      'src/components/pages/NotificationsPage.tsx',
      'src/components/pages/pipeline/PipelineFeed.tsx',
      'src/components/pages/plan-tab/PlanTabList.tsx',
      'src/components/chat/ChatInfoTabs.tsx',
      'src/components/chat/PostPicker.tsx',
      'src/components/chat/AssetPicker.tsx',
    ]) {
      expect(read(rel), rel).toMatch(/loadMoreRule\(|useLoadMoreFill\(|activityLoadMore\(/);
    }
  });

  it('the one exception: the Plan tab page is plan_bundle_read c_page (12), a proc constant with no limit argument', () => {
    // Changing it needs an approved schema change; until then it is the only
    // Load more list whose page is not the fill count.
    expect(read('src/lib/chat/plan-bundle.ts')).toContain('export const PLAN_BUNDLE_PAGE = 12;');
  });
});

describe('5. Clear is a Tool', () => {
  it('ClearButton renders no border, no fill, no pill', () => {
    const html = renderToStaticMarkup(<ClearButton onClick={() => {}} />);
    expect(html, 'ClearButton must not look like a chip').not.toMatch(
      /\bborder\b|border-|rounded-full|bg-/,
    );
    expect(html).toContain('>Clear</button>');
  });
});

describe('6. Chip is never an action', () => {
  // A chip filters or toggles: it carries selected (a pick) or tab (a segment).
  // An onClick with neither is an action and belongs on a Button level.
  const EXCEPTIONS = new Set<string>([]);
  it('every <Chip onClick> also states selected or tab', () => {
    const bad: string[] = [];
    for (const { rel, src } of TSX) {
      if (rel === 'src/components/ui/Chip.tsx') continue;
      for (const tag of openTags(src, 'Chip')) {
        if (!/\bonClick=/.test(tag)) continue;
        if (/\bselected\b|\btab\b|role="tab"/.test(tag)) continue;
        if (!EXCEPTIONS.has(rel)) bad.push(`${rel}: ${tag.replace(/\s+/g, ' ').slice(0, 100)}`);
      }
    }
    expect(bad, 'Use Button (Main / Button / Tool) for an action, Chip for a filter').toEqual([]);
  });
});
