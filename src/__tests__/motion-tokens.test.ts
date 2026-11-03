// Guard: the motion utilities resolve to the CSS motion tokens in src/index.css.
// They were once colour templates over variables that do not exist, so every
// transition silently fell back to Tailwind's 150ms default.

import { describe, expect, it } from 'vitest';
import resolveConfig from 'tailwindcss/resolveConfig';
import tailwindConfig from '../../tailwind.config';

const theme = resolveConfig(tailwindConfig).theme as unknown as {
  transitionDuration: Record<string, string>;
  transitionTimingFunction: Record<string, string>;
};

describe('motion tokens', () => {
  it('duration-fast/base/slow read the --dur-* tokens', () => {
    expect(theme.transitionDuration.fast).toBe('var(--dur-fast)');
    expect(theme.transitionDuration.base).toBe('var(--dur-base)');
    expect(theme.transitionDuration.slow).toBe('var(--dur-slow)');
  });

  it('ease-enter/exit read the --ease-* tokens', () => {
    expect(theme.transitionTimingFunction.enter).toBe('var(--ease-enter)');
    expect(theme.transitionTimingFunction.exit).toBe('var(--ease-exit)');
  });

  it('the nine-move durations and curves resolve to their tokens', () => {
    for (const name of [
      'push',
      'back',
      'grow',
      'grow-back',
      'sheet-in',
      'sheet-out',
      'menu',
      'toast',
      'wipe',
      'sweep',
    ]) {
      expect(theme.transitionDuration[name], name).toBe(`var(--dur-${name})`);
    }
    for (const name of ['ios', 'move', 'pop']) {
      expect(theme.transitionTimingFunction[name], name).toBe(`var(--ease-${name})`);
    }
  });
});
