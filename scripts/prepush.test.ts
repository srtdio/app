import { describe, expect, it } from 'vitest';
import { e2eReach } from './prepush.ts';

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
