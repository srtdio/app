// Guard: "First page fills the screen" (CLAUDE.md). Every list's first page and
// every Load more step (ui/LoadMore) is the fill count: one row more than the
// screen holds at the row height (ROW_HEIGHT 72), times the
// laptop columns, kept in 6..40. No device is hard-coded.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FILL_COUNT_CEILING, FILL_COUNT_FLOOR, fillColumns, fillCount } from '@/lib/use-fill-count';
import { ROW_HEIGHT } from '@/components/ui/layout';

const VIEWPORTS = [
  { name: 'iPhone', w: 390, h: 844, columns: 1 },
  { name: 'iPad', w: 820, h: 1180, columns: 1 },
  // Laptop: (1280 - 240 sidebar - 48 gutters) / 360 = 2.75, so 2 columns.
  { name: 'laptop', w: 1280, h: 800, columns: 2 },
] as const;

const row = ROW_HEIGHT;

function capped(n: number): number {
  return Math.min(FILL_COUNT_CEILING, Math.max(FILL_COUNT_FLOOR, n));
}

describe('fill count per viewport', () => {
  it('the row height is 72', () => {
    expect(row).toBe(72);
  });

  it('counts the laptop columns from the width left after the Sidebar and gutters', () => {
    for (const { w, columns } of VIEWPORTS) expect(fillColumns(w)).toBe(columns);
    expect(Math.floor((1280 - 240 - 48) / 360)).toBe(2);
  });

  for (const { name, w, h, columns } of VIEWPORTS) {
    {
      it(`${name} ${w}x${h} (${row}): at least one row past the fold, times columns`, () => {
        const count = fillCount(h, fillColumns(w), row);
        const floor = capped((Math.ceil(h / row) + 1) * columns);
        expect(count).toBeGreaterThanOrEqual(floor);
        expect(count).toBe(floor);
        expect(count).toBeGreaterThanOrEqual(FILL_COUNT_FLOOR);
        expect(count).toBeLessThanOrEqual(FILL_COUNT_CEILING);
        // The rows it draws (count / columns) run past the screen's height.
        if (count < FILL_COUNT_CEILING) {
          expect(Math.ceil(count / columns) * row).toBeGreaterThan(h);
        }
      });
    }
  }

  it('worked values: iPhone 13, iPad 18, laptop 26', () => {
    expect(fillCount(844, fillColumns(390), row)).toBe(13);
    expect(fillCount(1180, fillColumns(820), row)).toBe(18);
    expect(fillCount(800, fillColumns(1280), row)).toBe(26);
  });
});

// ---------------------------------------------------------------------------
// Source guard: each list screen takes its page size from the fill count, and
// the fixed page sizes it used before stay gone.
// ---------------------------------------------------------------------------

function source(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const FILL_IMPORT =
  /import\s*\{[^}]*\b(useFillCount|getFillCount)\b[^}]*\}\s*from\s*'@\/lib\/use-fill-count'/;

const LIST_SCREENS: { file: string; banned: RegExp[] }[] = [
  { file: '../components/pages/PipelinePage.tsx', banned: [] },
  { file: '../components/pages/pipeline/PipelineFeed.tsx', banned: [/useState\(\s*\d+\s*\)/] },
  {
    file: '../components/pages/BriefsPage.tsx',
    banned: [/briefs:\s*sortedBriefs,/, /briefSections\(\{\s*groups,/],
  },
  { file: '../components/pages/AssetsPage.tsx', banned: [] },
  {
    file: '../components/pages/assets/AssetListCard.tsx',
    banned: [/ASSET_LIST_PAGE/, /useState\(\s*\d+\s*\)/, /now \+ \d+/],
  },
  { file: '../components/chat/ChannelList.tsx', banned: [] },
  { file: '../components/pages/activity/ActivityBoxes.tsx', banned: [] },
  { file: '../components/pages/NotificationsPage.tsx', banned: [/ACTIVITY_PAGE_SIZE/] },
  { file: '../components/pages/plan-tab/PlanTabList.tsx', banned: [] },
  { file: '../components/pages/plan-tab/BankList.tsx', banned: [] },
  { file: './chat/plans.ts', banned: [/BANK_PAGE_SIZE \+ 1/, /slice\(0, BANK_PAGE_SIZE\)/] },
];

describe('list screens use the fill count', () => {
  for (const { file, banned } of LIST_SCREENS) {
    it(`${file} imports useFillCount / getFillCount and has no fixed page size`, () => {
      const text = source(file);
      expect(text).toMatch(FILL_IMPORT);
      for (const pattern of banned) expect(text).not.toMatch(pattern);
    });
  }

  it('the Activity reads pass the fill count as the page size (page one, Load more, prefetch)', () => {
    const page = source('../components/pages/NotificationsPage.tsx');
    expect(page.match(/pageSize: getFillCount\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    const data = source('../components/pages/activity/data.ts');
    expect(data).toMatch(FILL_IMPORT);
    expect(data).toContain('pageSize: getFillCount(),');
    expect(data).not.toMatch(/pageSize: ACTIVITY_PAGE_SIZE/);
  });

  it('the Bank passes its fill-count page size on every read (first page, live, Load more)', () => {
    const data = source('../components/pages/plan-tab/use-bank-data.ts');
    expect(data.match(/bankPageSize\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(source('./chat/plans.ts')).toContain('.limit(size + 1)');
  });

  it('Briefs caps the loaded list at the fill count and steps by it', () => {
    const page = source('../components/pages/BriefsPage.tsx');
    expect(page).toContain('const fill = useFillCount();');
    expect(page).toContain('capBriefGroups(groups, depth)');
    expect(page).toContain('const nextDepth = depth + fill;');
  });
});
