import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AREAS } from './e2e-areas.ts';
import {
  AREA_SCREENS,
  localScreens,
  ONE_SHARD_MAX,
  parseScreens,
  SCREEN_CAP,
  screensGrep,
  screensOfArea,
  selectForDiff,
  selectVisual,
  smokeScreens,
  SPEC_FILE,
  ONBOARDING_FILE,
  type GraphView,
  type VisualInput,
} from './visual-select.ts';

// A small screens.spec.ts: screens in one array, gated checks in capture().
const SPEC = [
  "import { assertWritingBox, checkLayout, assertAlignment } from './layout-checks';", // 1
  '', // 2
  'const SCREENS: Screen[] = [', // 3
  "  { name: 'chat-list', seed: null, url: '/chat', steps: chatReady },", // 4
  '  {', // 5
  "    name: 'chat-box',", // 6
  '    seed: null,', // 7
  "    url: '/chat/c1',", // 8
  '    steps: async (page) => {', // 9
  '      await chatReady(page);', // 10
  '    },', // 11
  '  },', // 12
  "  { name: 'pipeline', seed: null, url: '/pipeline', steps: ready },", // 13
  '  {', // 14
  '    name: `pipeline-${density}`,', // 15
  '    seed: null,', // 16
  "    url: '/pipeline',", // 17
  '    steps: async (page) => {', // 18
  "      await assertSameWidth(page, 'a', 'b');", // 19
  '    },', // 20
  '  },', // 21
  "  { name: 'briefs', seed: null, url: '/briefs', steps: ready },", // 22
  "  { name: 'brief-detail', seed: null, url: '/briefs/b1', steps: ready },", // 23
  "  { name: 'assets', seed: null, url: '/assets', steps: ready },", // 24
  "  { name: 'settings', seed: null, url: '/settings', steps: ready },", // 25
  "  { name: 'help', seed: null, url: '/help', steps: ready },", // 26
  "  { name: 'homepage', seed: null, url: '/', steps: ready },", // 27
  '];', // 28
  '', // 29
  'async function capture(screen: Screen, page: Page): Promise<void> {', // 30
  '  if (WRITING_BOX_SCREENS.has(screen.name)) await assertWritingBox(page, screen.name);', // 31
  '  await checkLayout(page, screen.name);', // 32
  '  const align = ALIGN_SCREENS[screen.name];', // 33
  '  if (align !== undefined) await assertAlignment(page, screen.name, align);', // 34
  '}', // 35
  '', // 36
  'const ALIGN_SCREENS: Readonly<Record<string, AlignScope>> = {', // 37
  "  'briefs': 'list',", // 38
  '};', // 39
  '', // 40
  "const WRITING_BOX_SCREENS = new Set(['chat-box', 'brief-detail']);", // 41
].join('\n');

const ONBOARDING = [
  'export const ONBOARDING_SCREENS: OnboardingScreen[] = [', // 1
  '  {', // 2
  "    name: 'onboarding-sign-up',", // 3
  "    url: '/signup',", // 4
  '  },', // 5
  '];', // 6
].join('\n');

// layout-checks.ts: two gated checks sharing a helper, and the ungated one.
const CHECKS = [
  "import type { Page } from '@playwright/test';", // 1
  '', // 2
  'function boxOf(x: number): number {', // 3
  '  return x;', // 4
  '}', // 5
  '', // 6
  'export async function assertWritingBox(page: Page, name: string): Promise<void> {', // 7
  '  boxOf(1);', // 8
  '}', // 9
  '', // 10
  'export async function assertAlignment(page: Page, name: string): Promise<void> {', // 11
  '  void page;', // 12
  '}', // 13
  '', // 14
  'export async function checkLayout(page: Page, name: string): Promise<void> {', // 15
  '  void page;', // 16
  '}', // 17
].join('\n');

const LC = 'e2e/visual/layout-checks.ts';

/** BriefCard.tsx sits in the briefs and onboarding closures; Button.tsx in chat and pipeline; AppLayout in the shell. */
const GRAPH: GraphView = {
  inShell: (f) => f === 'src/components/shell/AppLayout.tsx' || f === 'src/lib/shell-only.ts',
  areasOf: (f) =>
    ({
      'src/components/pages/BriefCard.tsx': ['briefs', 'onboarding'],
      'src/components/pages/BriefsPage.tsx': ['briefs'],
      'src/components/chat/Shared.tsx': ['chat', 'pipeline'],
      'src/components/pages/NoScreen.tsx': ['smoke'],
      'packages/schemas/src/x.ts': ['chat'],
    })[f] ?? [],
};

const input = (over: Partial<VisualInput>): VisualInput => ({
  files: [],
  sources: { [SPEC_FILE]: SPEC, [ONBOARDING_FILE]: ONBOARDING, [LC]: CHECKS },
  changedLines: () => [],
  graph: () => GRAPH,
  ...over,
});

const screens = [...parseScreens(SPEC), ...parseScreens(ONBOARDING, ONBOARDING_FILE)];
const sorted = (xs: readonly string[]): string[] => [...xs].sort();

describe('visual-select: parsing', () => {
  it('reads each screen with its url and span, ending where its array closes', () => {
    expect(screens.map((s) => [s.name, s.url])).toContainEqual([
      'pipeline-${density}',
      '/pipeline',
    ]);
    expect(screens.find((s) => s.name === 'chat-box')).toMatchObject({ start: 6, end: 12 });
    expect(screens.find((s) => s.name === 'homepage')?.end).toBe(27);
    expect(screens.find((s) => s.name === 'onboarding-sign-up')).toMatchObject({
      file: ONBOARDING_FILE,
      end: 5,
    });
  });

  it('every area but smoke and unsubscribe (no screen yet: smoke set) has screens in the real spec (no area forces ALL)', () => {
    const read = (f: string): string => readFileSync(path.resolve(__dirname, '../..', f), 'utf8');
    const real = [
      ...parseScreens(read(SPEC_FILE)),
      ...parseScreens(read(ONBOARDING_FILE), ONBOARDING_FILE),
    ];
    for (const a of AREAS) {
      expect(Object.keys(AREA_SCREENS), a.name).toContain(a.name);
      if (!['smoke', 'unsubscribe'].includes(a.name))
        expect(screensOfArea(real, a.name).length, a.name).toBeGreaterThan(0);
    }
  });
});

describe('visual-select: selection', () => {
  it('a single component: the screens of its area', () => {
    const sel = selectVisual(input({ files: ['src/components/pages/BriefsPage.tsx'] }));
    expect(sel.all).toBe(false);
    expect(sorted(sel.names)).toEqual(['brief-detail', 'briefs']);
  });

  it('BriefCard.tsx (briefs + onboarding closures): those screens, not ALL', () => {
    const sel = selectVisual(input({ files: ['src/components/pages/BriefCard.tsx'] }));
    expect(sel.all).toBe(false);
    expect(sorted(sel.names)).toEqual(['brief-detail', 'briefs', 'onboarding-sign-up']);
  });

  it('a shared component: the union of its areas; in the app shell: ALL', () => {
    const sel = selectVisual(input({ files: ['src/components/chat/Shared.tsx'] }));
    expect(sorted(sel.names)).toEqual(['chat-box', 'chat-list', 'pipeline', 'pipeline-${density}']);
    expect(selectVisual(input({ files: ['src/components/shell/AppLayout.tsx'] })).all).toBe(true);
    expect(selectVisual(input({ files: ['src/lib/shell-only.ts'] })).all).toBe(true);
  });

  it('an area with no screen: one smoke screen per area, not ALL', () => {
    const sel = selectVisual(input({ files: ['src/components/pages/NoScreen.tsx'] }));
    expect(sel.all).toBe(false);
    expect(sel.names).toEqual(smokeScreens(screens));
  });

  it('global CSS, fonts, tokens, configs and the lockfile: ALL', () => {
    for (const f of [
      'src/index.css',
      'public/fonts/inter.woff2',
      'tailwind.config.ts',
      'vite.config.ts',
      'package.json',
      'pnpm-lock.yaml',
      'e2e/visual/playwright.visual.config.ts',
      'src/App.tsx',
    ]) {
      expect(selectVisual(input({ files: [f] })).all, f).toBe(true);
    }
  });

  it('layout-checks.ts: ALL, aiming at the screens whose check changed', () => {
    // Line 4: inside boxOf, used by assertWritingBox (gated by WRITING_BOX_SCREENS).
    const sel = selectVisual(input({ files: [LC], changedLines: () => [4] }));
    expect(sel.all).toBe(true);
    expect(sorted(sel.targeted)).toEqual(['brief-detail', 'chat-box']);
    const align = selectVisual(input({ files: [LC], changedLines: () => [12] }));
    expect(align.targeted).toEqual(['briefs']);
  });

  it("screens.spec.ts: a screen's own lines run it; a shared helper line runs ALL", () => {
    const own = selectVisual(input({ files: [SPEC_FILE], changedLines: () => [10] }));
    expect(own).toMatchObject({ all: false, names: ['chat-box'] });
    expect(selectVisual(input({ files: [SPEC_FILE], changedLines: () => [32] })).all).toBe(true);
  });

  it('an unknown file or a src file no area reaches: ALL; non-UI paths: nothing', () => {
    expect(selectVisual(input({ files: ['some/new-thing.bin'] })).all).toBe(true);
    expect(selectVisual(input({ files: ['src/components/Orphan.tsx'] })).all).toBe(true);
    const none = selectVisual(
      input({
        files: [
          'scripts/prepush.ts',
          'CLAUDE.md',
          'src/server/logger.ts',
          'src/lib/time.test.ts',
          'src/components/shell/AppLayout.test.tsx',
          'src/components/chat/__tests__/__snapshots__/a.test.ts.snap',
          'supabase/migrations/1.sql',
          'e2e/tests/a.spec.ts',
          '.github/workflows/ci.yml',
          'packages/storage/src/unused.ts',
        ],
      }),
    );
    expect(none).toMatchObject({ all: false, names: [] });
    expect(selectVisual(input({ files: ['packages/schemas/src/x.ts'] })).names.length).toBe(2);
  });

  it('a selection error: ALL', async () => {
    const sel = await selectForDiff('no-such-ref-xyz', undefined, [SPEC_FILE]);
    expect(sel.all).toBe(true);
    expect(sel.reasons.join('\n')).toMatch(/selection error/);
  });
});

describe('visual-select: local runs and the grep', () => {
  it(`never more than ${SCREEN_CAP}: targeted first, round robin by area, smoke fills what is left`, () => {
    const many = Array.from(
      { length: 20 },
      (_, i) => `  { name: 'chat-${i}', url: '/chat/${i}' },`,
    );
    const big = parseScreens(
      ['const SCREENS = [', ...many, ...SPEC.split('\n').slice(3, 27), '];'].join('\n'),
    );
    const targeted = big.map((s) => s.name).filter((n) => n.startsWith('chat-') || n === 'briefs');
    const out = localScreens({ all: true, names: [], targeted, reasons: [] }, big);
    expect(out.names).toHaveLength(SCREEN_CAP);
    expect(out.names.slice(0, 2)).toEqual(['chat-0', 'briefs']);
    expect(out.names).not.toContain('pipeline');
    const few = localScreens({ all: true, names: [], targeted: ['briefs'], reasons: [] }, big);
    expect(few.names[0]).toBe('briefs');
    expect(few.names).toContain('pipeline');
    const some = localScreens(
      { all: false, names: ['briefs'], targeted: ['briefs'], reasons: [] },
      big,
    );
    expect(some.names).toEqual(['briefs']);
  });

  it('the grep matches a test title by its whole name, template names by pattern', () => {
    const re = new RegExp(screensGrep(['briefs', 'pipeline-${density}']));
    expect(re.test('briefs')).toBe(true);
    expect(re.test('iphone-light screens.spec.ts briefs @laptop-dark')).toBe(true);
    expect(re.test('pipeline-compact')).toBe(true);
    expect(re.test('briefs-empty')).toBe(false);
    expect(ONE_SHARD_MAX).toBe(20);
  });
});
