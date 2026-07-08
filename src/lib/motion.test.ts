import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DUR_BASE_MS, DUR_FAST_MS, DUR_SLOW_MS } from '@/lib/motion';

// Drift alarm between the CSS motion tokens (src/index.css) and the TS mirrors
// (src/lib/motion.ts). If either side is edited without the other, the assertion
// below fails and names both files.
const css = readFileSync(fileURLToPath(new URL('../index.css', import.meta.url)), 'utf8');

function tokenMs(name: string): number {
  const match = css.match(new RegExp(`--${name}:\\s*(\\d+)ms`));
  if (match === null) {
    throw new Error(`Token --${name} not found in src/index.css`);
  }
  return Number(match[1]);
}

describe('motion durations', () => {
  it('constants are positive integers', () => {
    for (const value of [DUR_FAST_MS, DUR_BASE_MS, DUR_SLOW_MS]) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });

  it('mirror the --dur-* tokens in src/index.css', () => {
    const pairs: Array<[string, number]> = [
      ['dur-fast', DUR_FAST_MS],
      ['dur-base', DUR_BASE_MS],
      ['dur-slow', DUR_SLOW_MS],
    ];
    for (const [token, constant] of pairs) {
      expect(
        tokenMs(token),
        `--${token} in src/index.css must equal its mirror in src/lib/motion.ts (${constant}ms). Update both together.`,
      ).toBe(constant);
    }
  });
});
