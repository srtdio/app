// Guard (9 Nov 2026, the Activity grouped-card expand restored in the flat
// list style): a grouped card's "N updates ⌄" is ui/ListCard's shared
// `tagToggle` (the one grey Tag + IconChevronDown, a 44 hit box over the
// cover, aria-expanded), never a hand-built button. ActivityCard passes
// `tagToggle=` and draws its unfolded rows with ui/PressableRow on
// LIST_CARD_SUB_INSET; no other file under src/components builds its own
// "updates" fold toggle.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const COMPONENTS = fileURLToPath(new URL('../components/', import.meta.url));
const LIST_CARD = 'ui/ListCard.tsx';
const ACTIVITY_CARD = 'pages/activity/ActivityCard.tsx';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : files(full);
    return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [full] : [];
  });
}

const FILES = files(COMPONENTS).map((full) => ({
  rel: relative(COMPONENTS, full).split(sep).join('/'),
  src: readFileSync(full, 'utf8'),
}));

const src = (rel: string): string => FILES.find((f) => f.rel === rel)?.src ?? '';

describe('guard: the updates toggle is ListCard tagToggle', () => {
  it('ListCard exports the toggle type and accepts tagToggle', () => {
    const part = src(LIST_CARD);
    expect(part).toMatch(/export interface ListCardTagToggle\b/);
    expect(part).toMatch(/^\s+tagToggle\?: ListCardTagToggle/m);
    expect(part).toContain('export const LIST_CARD_SUB_INSET');
    expect(part).toContain('export const LIST_CARD_TAG_TOGGLE');
    // The toggle: aria-expanded, the chevron turning through MOVE_CLASS, its own tap only.
    expect(part).toContain('aria-expanded={tagToggle.open}');
    expect(part).toContain('MOVE_CLASS.turn');
    expect(part).toContain('IconChevronDown');
    expect(part).toContain('event.stopPropagation()');
  });

  it('ActivityCard passes tagToggle= and draws no toggle of its own', () => {
    const card = src(ACTIVITY_CARD);
    expect(card).toContain('tagToggle={');
    expect(card).not.toContain('aria-expanded');
    expect(card).not.toContain('IconChevronDown');
    expect(card).not.toContain('<button');
    // The unfolded rows: the shared row part, on the card's text column.
    expect(card).toContain('<PressableRow');
    expect(card).toContain('LIST_CARD_SUB_INSET');
    expect(card).toContain('data-activity-sub-rows');
    expect(card).toContain('data-activity-sub-row={entry.id}');
    expect(card).toContain('data-activity-updates-toggle');
    // Fold motion from the motion lib: itemIn on open, itemOut before unmount.
    expect(card).toMatch(/enter: \(el\) => itemIn\(el\)/);
    expect(card).toMatch(/exit: \(el\) => itemOut\(el\)/);
  });

  it('no other component hand-builds an "updates" fold toggle', () => {
    const offenders = FILES.filter(({ rel }) => rel !== LIST_CARD && rel !== ACTIVITY_CARD)
      .filter(({ src: code }) => code.includes('aria-expanded'))
      // A count of updates: updatesLabel(n), `${n} updates`, "3 updates", 'updates'.
      .filter(({ src: code }) =>
        /updatesLabel\(|\}\s+updates?\b|\d\s+updates?\b|['"`]\s*updates?\s*['"`]/.test(code),
      )
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });
});
