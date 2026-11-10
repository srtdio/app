import { describe, expect, it } from 'vitest';
import { E2E_CAP, e2ePlan, e2eReach, e2eSpecs } from './prepush.ts';

// Screen selection lives in scripts/ci/visual-select.ts (tested beside it).
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

describe('prepush e2e plan (edited specs only, CI runs the suite)', () => {
  it('a tailwind.config.ts change skips e2e', () => {
    expect(e2ePlan(['tailwind.config.ts'], undefined)).toEqual({
      mode: 'skip',
      why: 'e2e runs in CI',
    });
  });

  it('one edited spec runs that spec only', () => {
    expect(
      e2ePlan(['e2e/tests/a.spec.ts', 'e2e/fixtures/chat-data.ts', 'src/index.css'], undefined),
    ).toEqual({ mode: 'edited', specs: ['e2e/tests/a.spec.ts'], dropped: [] });
  });

  it('five edited specs run the first 3, the rest are named for CI', () => {
    const specs = [1, 2, 3, 4, 5].map((n) => `e2e/tests/s${n}.spec.ts`);
    expect(E2E_CAP).toBe(3);
    expect(e2ePlan(specs, undefined)).toEqual({
      mode: 'edited',
      specs: specs.slice(0, 3),
      dropped: specs.slice(3),
    });
  });

  it("PREPUSH_E2E=all keeps today's selection", async () => {
    expect(e2ePlan(['tailwind.config.ts'], 'all')).toEqual({ mode: 'all' });
    expect(await e2eSpecs(['tailwind.config.ts'])).toEqual([]);
    expect(await e2eSpecs(['e2e/tests/a.spec.ts'])).toEqual(['e2e/tests/a.spec.ts']);
    expect(await e2eSpecs(['scripts/prepush.ts'])).toBeNull();
  });
});
