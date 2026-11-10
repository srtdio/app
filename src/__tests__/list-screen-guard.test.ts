// Guard (10 Nov 2026, CLAUDE.md "List tabs render through shell/ListScreen"):
// a migrated list tab renders through shell/ListScreen, which alone sets the
// chip row's top gap and side pads, the 16 to the first content and the side
// gutter. The tab never imports SectionHeader itself. MIGRATED grows tab by
// tab; the visual suite's assertListScreenAxis measures the same five
// positions on all six tabs.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Tabs on the shell (the next PR adds Briefs, Assets, Plan, Chat list, Activity). */
const MIGRATED: Record<string, string> = {
  PipelinePage: 'src/components/pages/PipelinePage.tsx',
};

describe('list tabs render through shell/ListScreen', () => {
  it('names Pipeline only for now', () => {
    expect(Object.keys(MIGRATED)).toEqual(['PipelinePage']);
  });

  for (const [name, path] of Object.entries(MIGRATED)) {
    const source = readFileSync(join(ROOT, path), 'utf8');

    it(`${name} imports ListScreen and renders <ListScreen`, () => {
      expect(source).toMatch(/from '@\/components\/shell\/ListScreen'/);
      expect(source).toMatch(/import \{[^}]*\bListScreen\b[^}]*\} from/);
      expect(source).toContain('<ListScreen');
    });

    it(`${name} does not import SectionHeader or PageHead directly`, () => {
      expect(source).not.toMatch(/from '@\/components\/shell\/SectionHeader'/);
      expect(source).not.toMatch(/\bSectionHeader\b/);
      expect(source).not.toMatch(/from '@\/components\/shell\/PageHead'/);
    });
  }
});
