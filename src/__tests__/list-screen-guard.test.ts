// Guard (10 Nov 2026, CLAUDE.md "List tabs render through shell/ListScreen"):
// a migrated list tab renders through shell/ListScreen, which alone sets the
// chip row's top gap and side pads, the 16 to the first content and the side
// gutter. The tab never imports SectionHeader itself. MIGRATED grows tab by
// tab (all six since 10 Nov 2026); the visual suite's assertListScreenAxis
// asserts the same five positions on all six tabs.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The six list tabs, all on the shell (10 Nov 2026). */
const MIGRATED: Record<string, string> = {
  PipelinePage: 'src/components/pages/PipelinePage.tsx',
  BriefsPage: 'src/components/pages/BriefsPage.tsx',
  AssetsPage: 'src/components/pages/AssetsPage.tsx',
  PlanTabPage: 'src/components/pages/PlanTabPage.tsx',
  ChannelList: 'src/components/chat/ChannelList.tsx',
  NotificationsPage: 'src/components/pages/NotificationsPage.tsx',
};

/**
 * The chat list keeps its own column (phone page scroll, laptop two panes), so
 * it takes the shell's exported chip row and classes instead of the whole
 * component; ChatPage keeps the screen's hidden title.
 */
const PARTS_ONLY = new Set(['ChannelList']);

/** The shell's numbers, written by a tab instead of taken from the shell. */
const OWN_NUMBERS = [
  /'border-b border-border pb-3'/,
  /className=\{cn\(GUTTER, 'mt-4'\)\}/,
  /\bpb-8 pt-4\b/,
  /'px-4 md:px-6 mt-4'/,
];

describe('list tabs render through shell/ListScreen', () => {
  it('names all six tabs', () => {
    expect(Object.keys(MIGRATED)).toEqual([
      'PipelinePage',
      'BriefsPage',
      'AssetsPage',
      'PlanTabPage',
      'ChannelList',
      'NotificationsPage',
    ]);
  });

  for (const [name, path] of Object.entries(MIGRATED)) {
    const source = readFileSync(join(ROOT, path), 'utf8');

    if (PARTS_ONLY.has(name)) {
      it(`${name} takes the shell's chip row, content top and gutter`, () => {
        expect(source).toMatch(/from '@\/components\/shell\/ListScreen'/);
        expect(source).toContain('listScreenChipRow(');
        expect(source).toContain('LIST_SCREEN_CONTENT_TOP');
        expect(source).toContain('LIST_SCREEN_GUTTER');
      });
    } else {
      it(`${name} imports ListScreen and renders <ListScreen`, () => {
        expect(source).toMatch(/from '@\/components\/shell\/ListScreen'/);
        expect(source).toMatch(/import \{[^}]*\bListScreen\b[^}]*\} from/);
        expect(source).toContain('<ListScreen');
      });
    }

    it(`${name} does not import SectionHeader or PageHead directly`, () => {
      expect(source).not.toMatch(/from '@\/components\/shell\/SectionHeader'/);
      expect(source).not.toMatch(/\bSectionHeader\b/);
      expect(source).not.toMatch(/from '@\/components\/shell\/PageHead'/);
    });

    it(`${name} writes none of the shell's numbers itself`, () => {
      for (const own of OWN_NUMBERS) expect(source).not.toMatch(own);
    });
  }
});
