import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AREAS } from './e2e-areas.ts';
import {
  missingBaselines,
  AREA_SCREENS,
  areaOfScreen,
  ciPlan,
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
  GALLERY_FILE,
  galleryScreenOf,
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

describe('visual-select: per screen (screen-files.json) and the PR cap', () => {
  const MAP = {
    'chat-list': ['src/components/chat/List.tsx', 'src/components/chat/Shared.tsx'],
    'chat-box': ['src/components/chat/Shared.tsx'],
    'pipeline-compact': ['src/components/chat/Shared.tsx'],
    briefs: ['src/components/pages/BriefsPage.tsx'],
    'brief-detail': ['src/components/pages/BriefsPage.tsx'],
    assets: ['src/components/pages/Assets.tsx'],
    settings: [],
    help: [],
    homepage: [],
    'onboarding-sign-up': [],
  };
  // pipeline (plain) is missing from the map: a new screen.

  it("(a) a file in two screens' map entries selects exactly those two", () => {
    const sel = selectVisual(input({ files: ['src/components/pages/BriefsPage.tsx'], map: MAP }));
    expect(sel.all).toBe(false);
    expect(sorted(sel.names)).toEqual(['brief-detail', 'briefs']);
    // A shared file: its map holders plus the new screens of its areas (pipeline).
    const shared = selectVisual(input({ files: ['src/components/chat/Shared.tsx'], map: MAP }));
    expect(sorted(shared.names)).toEqual(['chat-box', 'chat-list', 'pipeline', 'pipeline-compact']);
  });

  it('(b) a FORCE_ALL file on a PR: mode some, at most 20, one smoke screen per uncovered area', () => {
    const sel = selectVisual(input({ files: ['src/index.css'], map: MAP }));
    expect(sel.all).toBe(true);
    const plan = ciPlan(sel, screens, MAP, true);
    expect(plan.mode).toBe('some');
    expect(plan.names.length).toBeLessThanOrEqual(ONE_SHARD_MAX);
    expect(plan.radius).toBe(screens.length);
    const areas = plan.names.map((n) => areaOfScreen(screens.find((s) => s.name === n)));
    expect(new Set(areas).size).toBe(areas.length);
    expect(sorted(plan.names)).toEqual(sorted(smokeScreens(screens)));
  });

  it('(c) a radius of 50 screens runs 20 on a PR, the selected screens first in map order', () => {
    const many = Array.from(
      { length: 50 },
      (_, i) => `  { name: 'chat-${100 + i}', url: '/chat/${i}' },`,
    );
    const big = parseScreens(
      ['const SCREENS = [', ...many, ...SPEC.split('\n').slice(3, 27), '];'].join('\n'),
    );
    const names = big.map((s) => s.name).filter((n) => /^chat-1\d\d$/.test(n));
    const map = Object.fromEntries([...names].reverse().map((n) => [n, ['src/x.ts']]));
    const plan = ciPlan({ all: false, names, targeted: names, reasons: [] }, big, map, true);
    expect(plan).toMatchObject({ mode: 'some', radius: 50 });
    expect(plan.names).toHaveLength(ONE_SHARD_MAX);
    expect(plan.names).toEqual(Object.keys(map).slice(0, ONE_SHARD_MAX));
    // Under the cap: the selection as is.
    const few = ciPlan(
      { all: false, names: ['briefs'], targeted: ['briefs'], reasons: [] },
      big,
      map,
      true,
    );
    expect(few).toEqual({ mode: 'some', names: ['briefs'], radius: 1 });
  });

  it('(c2) screens with a missing baseline run first on a PR, even past the cap', () => {
    const many = Array.from(
      { length: 50 },
      (_, i) => `  { name: 'chat-${100 + i}', url: '/chat/${i}' },`,
    );
    const big = parseScreens(
      ['const SCREENS = [', ...many, ...SPEC.split('\n').slice(3, 27), '];'].join('\n'),
    );
    const names = big.map((s) => s.name).filter((n) => /^chat-1\d\d$/.test(n));
    const map = Object.fromEntries(names.slice(0, 40).map((n) => [n, ['src/x.ts']]));
    const images = new Set(
      names.filter((n) => n !== 'chat-149' && n !== 'chat-148').map((n) => `iphone-light/${n}.png`),
    );
    images.add('iphone-light/chat-147.png');
    const missing = missingBaselines(big, images, new Set(['chat-147']));
    expect([...missing].filter((n) => n.startsWith('chat-1')).sort()).toEqual([
      'chat-147',
      'chat-148',
      'chat-149',
    ]);
    const plan = ciPlan(
      { all: false, names, targeted: names, reasons: [] },
      big,
      map,
      true,
      ONE_SHARD_MAX,
      new Set(['chat-147', 'chat-148', 'chat-149']),
    );
    expect(plan.names).toHaveLength(ONE_SHARD_MAX);
    expect(plan.names.slice(0, 3)).toEqual(['chat-147', 'chat-148', 'chat-149']);
  });

  it('(d) a new file (in no map entry) falls back to its area', () => {
    const sel = selectVisual(input({ files: ['src/components/pages/BriefCard.tsx'], map: MAP }));
    expect(sel.all).toBe(false);
    expect(sorted(sel.names)).toEqual(['brief-detail', 'briefs', 'onboarding-sign-up']);
  });

  it('(e) a missing map: the area rule', () => {
    const sel = selectVisual(input({ files: ['src/components/chat/Shared.tsx'], map: null }));
    expect(sorted(sel.names)).toEqual(['chat-box', 'chat-list', 'pipeline', 'pipeline-${density}']);
    expect(sel.reasons.join('\n')).toMatch(/missing or unreadable/);
  });

  it('(f) the nightly path (not a PR) yields all', () => {
    const sel = selectVisual(input({ files: ['src/index.css'], map: MAP }));
    expect(ciPlan(sel, screens, MAP, false)).toEqual({
      mode: 'all',
      names: [],
      radius: screens.length,
    });
  });

  it('screen-files.json itself selects nothing', () => {
    const sel = selectVisual(input({ files: ['e2e/visual/screen-files.json'], map: MAP }));
    expect(sel).toMatchObject({ all: false, names: [] });
  });
});

describe('visual-select: the parts gallery (gallery.spec.ts)', () => {
  // A small gallery.spec.ts: one line per gallery screen.
  const GALLERY = [
    "import { test } from '@playwright/test';", // 1
    '', // 2
    'const GALLERY: GalleryScreen[] = [', // 3
    "  { name: 'gallery-Button', url: '/gallery/Button' },", // 4
    "  { name: 'gallery-Chip', url: '/gallery/Chip' },", // 5
    "  { name: 'gallery-Tag', url: '/gallery/Tag' },", // 6
    '];', // 7
    '', // 8
    'for (const screen of GALLERY) test(screen.name, async () => {});', // 9
  ].join('\n');
  const withGallery = (over: Partial<VisualInput>): VisualInput =>
    input({
      sources: {
        [SPEC_FILE]: SPEC,
        [ONBOARDING_FILE]: ONBOARDING,
        [LC]: CHECKS,
        [GALLERY_FILE]: GALLERY,
      },
      ...over,
    });
  const all = [...screens, ...parseScreens(GALLERY, GALLERY_FILE)];
  const MAP = { 'chat-list': ['src/components/ui/Button.tsx'], briefs: ['src/x.tsx'] };

  it('parses one gallery screen per line, url /gallery/<Part>', () => {
    const own = parseScreens(GALLERY, GALLERY_FILE);
    expect(own.map((s) => [s.name, s.url, s.start, s.end])).toEqual([
      ['gallery-Button', '/gallery/Button', 4, 4],
      ['gallery-Chip', '/gallery/Chip', 5, 5],
      ['gallery-Tag', '/gallery/Tag', 6, 6],
    ]);
    expect(galleryScreenOf('src/components/ui/Chip.tsx')).toBe('gallery-Chip');
    expect(galleryScreenOf('src/components/ui/Chip.test.tsx')).toBeNull();
  });

  it("a gallery test's own line selects it; a shared line runs ALL", () => {
    const own = selectVisual(withGallery({ files: [GALLERY_FILE], changedLines: () => [5] }));
    expect(own).toMatchObject({ all: false, names: ['gallery-Chip'] });
    const shared = selectVisual(withGallery({ files: [GALLERY_FILE], changedLines: () => [9] }));
    expect(shared.all).toBe(true);
  });

  it('a changed ui part always selects its gallery screen, beside its map screens', () => {
    const sel = selectVisual(withGallery({ files: ['src/components/ui/Button.tsx'], map: MAP }));
    expect(sorted(sel.names)).toEqual(['chat-list', 'gallery-Button']);
    // A ui part with no gallery page yet: no gallery screen.
    const none = selectVisual(withGallery({ files: ['src/components/ui/Sheet.tsx'], map: MAP }));
    expect(none.targeted).not.toContain('gallery-Sheet');
    // Even when the part runs ALL (no area, no map entry), its gallery screen is targeted.
    const wide = selectVisual(withGallery({ files: ['src/components/ui/Tag.tsx'], map: MAP }));
    expect(wide.all).toBe(true);
    expect(wide.targeted).toContain('gallery-Tag');
  });

  it('a gallery page selects its screen; a shared gallery file every gallery screen', () => {
    const page = selectVisual(withGallery({ files: ['e2e/gallery/Chip.tsx'] }));
    expect(page).toMatchObject({ all: false, names: ['gallery-Chip'] });
    for (const f of ['e2e/gallery/register.ts', 'e2e/gallery/frame.tsx', 'e2e/gallery/New.tsx']) {
      const sel = selectVisual(withGallery({ files: [f] }));
      expect(sel.all, f).toBe(false);
      expect(sorted(sel.names), f).toEqual(['gallery-Button', 'gallery-Chip', 'gallery-Tag']);
    }
  });

  it('a gallery baseline selects its screen', () => {
    const sel = selectVisual(
      withGallery({ files: ['e2e/visual/__screenshots__/chrome-phone/gallery-Tag.png'] }),
    );
    expect(sel).toMatchObject({ all: false, names: ['gallery-Tag'] });
  });

  it('on a PR the gallery screens go first inside the cap', () => {
    const many = Array.from({ length: 30 }, (_, i) => `chat-${i}`);
    const big = [
      ...parseScreens(
        ['const SCREENS = [', ...many.map((n) => `  { name: '${n}', url: '/chat/x' },`), '];'].join(
          '\n',
        ),
      ),
      ...parseScreens(GALLERY, GALLERY_FILE),
    ];
    const map = Object.fromEntries(many.map((n) => [n, ['src/a.tsx']]));
    const sel = {
      all: false,
      names: [...many, 'gallery-Tag', 'gallery-Button'],
      targeted: [],
      reasons: [],
    };
    const plan = ciPlan(sel, big, map, true);
    expect(plan.names).toHaveLength(ONE_SHARD_MAX);
    expect(plan.names.slice(0, 2)).toEqual(['gallery-Button', 'gallery-Tag']);
    // ALL on a PR (a global file): the targeted gallery screen still leads.
    const wide = selectVisual(withGallery({ files: ['src/components/ui/Tag.tsx'], map: MAP }));
    expect(ciPlan(wide, all, MAP, true).names[0]).toBe('gallery-Tag');
  });
});
