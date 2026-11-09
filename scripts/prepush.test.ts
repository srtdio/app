import { describe, expect, it } from 'vitest';
import {
  capByArea,
  e2eReach,
  parseScreens,
  SCREEN_CAP,
  screensGrep,
  selectScreens,
  smokeScreens,
  type VisualInput,
} from './prepush.ts';

// A small screens.spec.ts: screens in two arrays, gated checks in capture().
const SPEC = [
  "import { assertWritingBox, checkLayout, assertAlignment, assertSameWidth } from './layout-checks';", // 1
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
  "  { name: 'home', seed: null, url: '/', steps: ready },", // 27
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

// layout-checks.ts: two checks sharing a helper.
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
const screens = parseScreens(SPEC);

const input = (over: Partial<VisualInput>): VisualInput => ({
  files: [],
  screens,
  specSource: SPEC,
  checkSources: { [LC]: CHECKS },
  changedLines: () => [],
  componentUrls: [],
  componentGlobal: [],
  ...over,
});

const SMOKE = ['chat-list', 'pipeline', 'briefs', 'assets', 'settings', 'help'];

describe('prepush screen selection', () => {
  it('reads each screen with its url, the span ending where its array closes', () => {
    expect(screens.map((s) => [s.name, s.url])).toContainEqual([
      'pipeline-${density}',
      '/pipeline',
    ]);
    expect(screens.find((s) => s.name === 'chat-box')).toMatchObject({ start: 6, end: 13 - 1 });
    expect(screens.find((s) => s.name === 'home')?.end).toBe(27);
  });

  it('smoke: the plain page of each area', () => {
    expect(smokeScreens(screens)).toEqual(SMOKE);
  });

  it('a single component runs only the screens of the area it feeds', () => {
    const plan = selectScreens(
      input({ files: ['src/components/pages/BriefCard.tsx'], componentUrls: ['/briefs'] }),
    );
    expect(plan.names.sort()).toEqual(['brief-detail', 'briefs']);
  });

  it('a component in the shell or an area with no screen url adds one screen per area, not all', () => {
    const plan = selectScreens(
      input({
        files: ['src/components/pages/BriefCard.tsx'],
        componentUrls: ['/briefs'],
        componentGlobal: ['area onboarding has no screen url'],
      }),
    );
    expect(plan.names.slice(0, 2).sort()).toEqual(['brief-detail', 'briefs']);
    expect(plan.names).toEqual(expect.arrayContaining(SMOKE));
    expect(plan.names).not.toContain('home');
  });

  it('a layout-checks.ts change runs the screens whose check changed plus the smoke set', () => {
    // Line 4: inside boxOf, used by assertWritingBox (gated by WRITING_BOX_SCREENS).
    const plan = selectScreens(input({ files: [LC], changedLines: () => [4] }));
    expect(plan.names.slice(0, 2).sort()).toEqual(['brief-detail', 'chat-box']);
    expect(plan.names).toEqual(expect.arrayContaining(['pipeline', 'assets', 'settings', 'help']));
    expect(plan.names).not.toContain('home');
    expect(plan.names).not.toContain('pipeline-${density}');
  });

  it('a check gated by a record or called in a screen entry reaches those screens', () => {
    const align = selectScreens(input({ files: [LC], changedLines: () => [12] }));
    expect(align.names[0]).toBe('briefs');
    const core = 'e2e/visual/layout-checks-core.ts';
    const sameWidth = selectScreens(
      input({
        files: [core],
        checkSources: {
          [LC]: CHECKS,
          [core]: 'export function assertSameWidth(): void {\n  return;\n}',
        },
        changedLines: (f) => (f === core ? [2] : []),
      }),
    );
    expect(sameWidth.names[0]).toBe('pipeline-${density}');
  });

  it('a shared file with no check change (config, header line) runs the smoke set only', () => {
    expect(
      selectScreens(input({ files: ['e2e/visual/playwright.visual.config.ts'] })).names,
    ).toEqual(SMOKE);
    expect(selectScreens(input({ files: [LC], changedLines: () => [1] })).names).toEqual(SMOKE);
    expect(selectScreens(input({ files: ['e2e/visual/emails.spec.ts'] })).names).toEqual(SMOKE);
  });

  it("a screen's own lines run that screen only", () => {
    const plan = selectScreens(
      input({ files: ['e2e/visual/screens.spec.ts'], changedLines: () => [10] }),
    );
    expect(plan.names).toEqual(['chat-box']);
  });

  it('no visual file: no run', () => {
    expect(selectScreens(input({ files: ['src/lib/time.ts'] })).names).toEqual([]);
  });

  it(`never more than ${SCREEN_CAP}: targeted first, round robin by area, smoke fills what is left`, () => {
    const many = Array.from(
      { length: 20 },
      (_, i) => `  { name: 'chat-${i}', url: '/chat/${i}' },`,
    );
    const big = parseScreens(
      ['const SCREENS = [', ...many, ...SPEC.split('\n').slice(3, 27), '];'].join('\n'),
    );
    const names = big.map((s) => s.name).filter((n) => n.startsWith('chat-') || n === 'briefs');
    const out = capByArea(names, smokeScreens(big), big);
    expect(out).toHaveLength(SCREEN_CAP);
    expect(out.slice(0, 2)).toEqual(['chat-0', 'briefs']);
    expect(out).not.toContain('pipeline');
    const few = capByArea(['briefs'], smokeScreens(big), big);
    expect(few[0]).toBe('briefs');
    expect(few.filter((n) => n === 'briefs')).toHaveLength(1);
    expect(few).toContain('pipeline');
  });

  it('the grep matches a test title by its whole name, template names by pattern', () => {
    const re = new RegExp(screensGrep(['briefs', 'pipeline-${density}']));
    expect(re.test('briefs')).toBe(true);
    expect(re.test('briefs @laptop-dark')).toBe(true);
    expect(re.test('pipeline-compact')).toBe(true);
    expect(re.test('briefs-empty')).toBe(false);
  });
});

describe('prepush e2e reach (as e2e-webkit.yml)', () => {
  it('non-UI paths, Worker code and unit tests run no spec', () => {
    expect(
      e2eReach([
        'scripts/prepush.ts',
        'CLAUDE.md',
        'tests/rls/a.test.ts',
        'src/server/logger.ts',
        'src/lib/time.test.ts',
        'src/__tests__/no-cross.test.ts',
        'e2e/visual/layout-checks.ts',
      ]),
    ).toEqual({ own: [], app: [], whole: false });
  });

  it('a spec runs itself, src goes to the selector, other UI files run the whole suite', () => {
    expect(e2eReach(['e2e/tests/a.spec.ts', 'src/components/pages/BriefCard.tsx'])).toEqual({
      own: ['e2e/tests/a.spec.ts'],
      app: ['src/components/pages/BriefCard.tsx'],
      whole: false,
    });
    expect(e2eReach(['e2e/fixtures/chat-data.ts']).whole).toBe(true);
    expect(e2eReach(['tailwind.config.ts']).whole).toBe(true);
  });
});
