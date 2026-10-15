import { readdirSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { AREAS } from './e2e-areas.ts';
import { REPO_ROOT, buildGraph, checkSpecCoverage, select, type Graph } from './e2e-select.ts';

const HOME = ['e2e/tests/home-pages.spec.ts'];
const isChat = (s: string): boolean => s.startsWith('e2e/tests/chat-');

describe('e2e-select', () => {
  let graph: Graph;
  beforeAll(() => {
    graph = buildGraph();
  }, 60_000);

  it('a new file in the homepage folder runs the home specs only', () => {
    const r = select(['src/components/home/X.tsx'], graph);
    expect(r.all).toBe(false);
    expect(r.specs).toEqual(HOME);
  });

  it('a settings-only file runs the settings specs and no chat specs', () => {
    const r = select(['src/components/settings/ProfileSettingsPanel.tsx'], graph);
    const settings = AREAS.find((a) => a.name === 'settings')?.specs ?? [];
    expect(r.all).toBe(false);
    expect(r.specs).toEqual([...settings].sort());
    expect(r.specs.filter(isChat)).toEqual([]);
  });

  it('src/lib/asset-upload.ts (imported by the chat Composer) includes the chat specs', () => {
    expect(graph.closures.get('chat')?.has('src/lib/asset-upload.ts')).toBe(true);
    const r = select(['src/lib/asset-upload.ts'], graph);
    expect(r.all || r.specs.some(isChat)).toBe(true);
  });

  it('a chat component runs chat specs, not the homepage', () => {
    const r = select(['src/components/chat/Composer.tsx'], graph);
    expect(r.all).toBe(false);
    expect(r.specs).toContain('e2e/tests/chat-thread.spec.ts');
    expect(r.specs).not.toContain(HOME[0]);
  });

  it('the app shell runs the whole suite', () => {
    expect(select(['src/components/shell/AppLayout.tsx'], graph).all).toBe(true);
  });

  it('an unknown new file under src runs the whole suite', () => {
    expect(select(['src/lib/not-a-real-file-yet.ts'], graph).all).toBe(true);
  });

  it('shared UI, stylesheets and e2e plumbing run the whole suite', () => {
    for (const f of [
      'src/components/ui/Button.tsx',
      'src/index.css',
      'e2e/fixtures/chat-data.ts',
      'e2e/harness/main.tsx',
      'playwright.config.ts',
      'scripts/ci/e2e-areas.ts',
    ]) {
      expect(select([f], graph).all, f).toBe(true);
    }
  });

  it('every spec in e2e/tests is assigned to an area', () => {
    expect(() => checkSpecCoverage()).not.toThrow();
    const listed = new Set(AREAS.flatMap((a) => a.specs));
    const onDisk = readdirSync(path.join(REPO_ROOT, 'e2e/tests')).filter((f) =>
      f.endsWith('.spec.ts'),
    );
    expect(onDisk.length).toBeGreaterThan(0);
    for (const f of onDisk) expect(listed.has(`e2e/tests/${f}`), f).toBe(true);
  });

  it('an unassigned spec fails loudly', () => {
    const without = AREAS.map((a) => ({
      ...a,
      specs: a.specs.filter((s) => s !== 'e2e/tests/smoke.spec.ts'),
    }));
    expect(() => checkSpecCoverage(without)).toThrow(/smoke\.spec\.ts/);
  });
});
