import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INDUCTION_KEYS } from '@/lib/induction-keys';

// Onboarding follows the app (CLAUDE.md): the tour finds its controls by
// data-induction. Every key the tour names must sit on a real control in
// src/components, and every control carrying a key must be named by the tour or
// listed below. A UI change that moves, renames or drops an anchor fails here
// until the tour step, its copy and its baselines move with it.
const SRC = fileURLToPath(new URL('../', import.meta.url));
const COMPONENTS = join(SRC, 'components');

/** The tour: its routes, model, copy, entry taps and data reads. */
const TOUR_FILES = [
  'lib/induction.ts',
  'lib/induction-routes.ts',
  'lib/induction-copy.ts',
  'lib/induction-model.ts',
  'lib/onboarding.ts',
  'components/induction/induction-data.ts',
];

/**
 * Anchors placed in the app that no tour step names today. Each stays marked so
 * a step can return to it; delete the entry and the attribute together.
 */
const UNTOURED: Record<string, string> = {
  activityList: 'Activity list',
  assetsAdd: 'Assets add menu',
  chatAttachTray: 'chat composer tray',
  chatHash: 'chat composer #',
  chatMic: 'chat composer mic',
  chatPlus: 'chat composer attach',
  chatPostCard: 'post card in chat',
  chatTab: 'Chat tab and sidebar row',
  chatTasks: 'chat tasks button',
  pipelineDraftChip: 'Pipeline Draft chip',
  pipelineStageRow: 'Pipeline stage row',
  postCommentComposer: 'post comment composer',
};

/**
 * Components that put a key handed in as a prop onto their control. The caller
 * form counts as the placement; the forwarder must really render it.
 */
const FORWARDERS: { file: string; renders: RegExp; caller: RegExp }[] = [
  {
    file: 'components/onboarding/OnboardingFlow.tsx',
    renders: /data-induction=\{anchor\}/,
    caller: /\banchor=\{INDUCTION_KEYS\.(\w+)\}/g,
  },
  {
    file: 'components/comments/CommentComposer.tsx',
    renders: /data-induction=\{submitAnchor\}/,
    caller: /\bsubmitAnchor:\s*INDUCTION_KEYS\.(\w+)/g,
  },
  {
    file: 'components/ui/ApproveConfirm.tsx',
    renders: /'data-induction':\s*props\.induction/,
    caller: /\binduction=\{INDUCTION_KEYS\.(\w+)\}/g,
  },
];

/** The ways a component sets a key on its own control. */
const PLACEMENTS = [
  /data-induction=\{[^}]*?INDUCTION_KEYS\.(\w+)/g,
  /'data-induction':\s*INDUCTION_KEYS\.(\w+)/g,
  /setAttribute\(\s*'data-induction',\s*INDUCTION_KEYS\.(\w+)/g,
];

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsxFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

const COMPONENT_FILES = tsxFiles(COMPONENTS).map((path) => ({
  rel: relative(SRC, path).split(sep).join('/'),
  src: readFileSync(path, 'utf8'),
}));

const names = (src: string, re: RegExp): string[] =>
  Array.from(src.matchAll(new RegExp(re.source, 'g')), (m) => m[1] ?? '');

const TOUR = new Set(
  TOUR_FILES.flatMap((rel) => names(read(rel), /\b(?:INDUCTION_KEYS|K)\.(\w+)/)),
);

/** key name -> the component files that place it. */
const PLACED = new Map<string, string[]>();
for (const { rel, src } of COMPONENT_FILES) {
  const found = [
    ...PLACEMENTS.flatMap((re) => names(src, re)),
    ...FORWARDERS.flatMap((f) => names(src, f.caller)),
  ];
  for (const name of new Set(found)) PLACED.set(name, [...(PLACED.get(name) ?? []), rel]);
}

describe('induction anchors: the tour and the app agree', () => {
  it('reads the tour files and finds both sides', () => {
    expect(TOUR.size).toBeGreaterThan(0);
    expect(PLACED.size).toBeGreaterThan(0);
  });

  it('every key the tour names is a real INDUCTION_KEYS entry', () => {
    expect([...TOUR].filter((name) => !(name in INDUCTION_KEYS)).sort()).toEqual([]);
  });

  it('every key the tour names sits on a control as data-induction', () => {
    expect([...TOUR].filter((name) => !PLACED.has(name)).sort()).toEqual([]);
  });

  it('every data-induction control is named by the tour or listed in UNTOURED', () => {
    const orphans = [...PLACED.entries()]
      .filter(([name]) => !TOUR.has(name) && UNTOURED[name] === undefined)
      .map(([name, files]) => `${name} (${files.join(', ')})`);
    expect(orphans.sort()).toEqual([]);
  });

  it('UNTOURED holds only anchors still placed and still not toured', () => {
    const stale = Object.keys(UNTOURED).filter((name) => !PLACED.has(name) || TOUR.has(name));
    expect(stale).toEqual([]);
  });

  it('every INDUCTION_KEYS entry is toured or placed (no dead keys)', () => {
    const dead = Object.keys(INDUCTION_KEYS).filter((name) => !TOUR.has(name) && !PLACED.has(name));
    expect(dead).toEqual([]);
  });

  it('forwarders render the key they are handed', () => {
    for (const forwarder of FORWARDERS) {
      expect(read(forwarder.file), forwarder.file).toMatch(forwarder.renders);
    }
  });

  it('no component writes a key as a string literal (keys come from INDUCTION_KEYS)', () => {
    const literal = /data-induction=["'][^"']|'data-induction'\s*[:,]\s*['"`]/g;
    const offenders = COMPONENT_FILES.flatMap(({ rel, src }) =>
      Array.from(
        src.matchAll(literal),
        (m) => `${rel}:${src.slice(0, m.index).split('\n').length}`,
      ),
    );
    expect(offenders).toEqual([]);
  });
});
