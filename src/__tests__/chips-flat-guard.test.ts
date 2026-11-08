// Guard (CLAUDE.md Design rules, 8 Nov 2026): "Chips: every chip-like control
// uses Chip or CHIP_* exports; no grey-filled pills." A pill with text padding
// (rounded-full + px-/pl-) on a grey fill (bg-panel-2 / bg-panel-3 / lit-well*)
// fails CI anywhere in src/components unless its file is in KEEP with a reason.
// The flattened chip sites must draw their face from the shared CHIP_* exports.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const COMPONENTS = fileURLToPath(new URL('../components/', import.meta.url));

/** file -> why its grey pill is not a chip. */
const KEEP: Record<string, string> = {
  'induction/GuideParts.tsx': 'tour step count pill, read-only text, not a control',
  'ui/Switch.tsx': 'the switch track, not a chip',
  'ui/CountBadge.tsx': 'the count badge part',
  'chat/tasks/TaskEventLine.tsx': 'a task event line in chat, read-only text',
};

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

/** Class strings that draw a grey-filled pill with text padding. Pure. */
function greyPills(code: string): string[] {
  return [...code.matchAll(/(['"`])([^'"`\n]*)\1/g)]
    .map((m) => m[2] ?? '')
    .filter(
      (cls) =>
        /(^|\s)rounded-full(\s|$)/.test(cls) &&
        /(^|\s)(px|pl)-\d/.test(cls) &&
        /(^|\s)(bg-panel-2|bg-panel-3|lit-well|lit-well-soft)(\s|$)/.test(cls),
    );
}

describe('chips are flat (Chip or CHIP_* exports, no grey-filled pills)', () => {
  it('no grey-filled pill outside KEEP', () => {
    const offenders = FILES.filter(({ rel }) => !(rel in KEEP)).flatMap(({ rel, src: code }) =>
      greyPills(code).map((cls) => `${rel}: ${cls}`),
    );
    expect(offenders).toEqual([]);
  });

  it('every KEEP entry names a file that exists and gives a reason', () => {
    for (const [rel, why] of Object.entries(KEEP)) {
      expect(src(rel), rel).not.toBe('');
      expect(why.length, rel).toBeGreaterThan(10);
    }
  });

  it('the flattened chip sites draw from Chip or the CHIP_* exports', () => {
    expect(src('shell/Tabs.tsx')).toContain('<Chip');
    expect(src('pages/HelpPage.tsx')).toMatch(/CHIP_HIT[\s\S]*CHIP_FACE_SIZE[\s\S]*CHIP_REST_EDGE/);
    expect(src('auth/PlanBackdrop.tsx')).toContain('CHIP_PICKED_EDGE');
    expect(src('auth/PlanBackdrop.tsx')).toContain('CHIP_REST_EDGE');
    expect(src('chat/tasks/TaskSheet.tsx')).toContain('<Chip');
  });

  it('the old grey chip looks are gone from those sites', () => {
    for (const rel of [
      'shell/Tabs.tsx',
      'pages/HelpPage.tsx',
      'chat/tasks/TaskSheet.tsx',
      'chat/PlanDayPickerSheet.tsx',
      'chat/PostRefChip.tsx',
      'auth/PlanBackdrop.tsx',
    ]) {
      const code = src(rel);
      expect(code, rel).not.toContain('lit-well-soft');
      expect(code, rel).not.toContain('rounded-full bg-panel-2');
    }
    expect(src('chat/PostRefChip.tsx')).not.toContain('rounded-full bg-panel-3');
    expect(src('chat/PlanDayPickerSheet.tsx')).not.toContain('bg-accent text-accent-fg');
    expect(src('chat/tasks/TaskSheet.tsx')).not.toContain('flex-auto justify-center truncate');
  });

  it('the scan catches what it should', () => {
    expect(
      greyPills('<a className="inline-flex rounded-full bg-panel-3 px-4 text-fg" />'),
    ).toHaveLength(1);
    expect(greyPills('<a className="rounded-full lit-well-soft px-4" />')).toHaveLength(1);
    expect(greyPills('<a className="rounded-full border border-border-strong px-4" />')).toEqual(
      [],
    );
    expect(greyPills('<span className="h-2 w-2 rounded-full bg-panel-3" />')).toEqual([]);
  });
});
