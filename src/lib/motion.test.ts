import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DURATION_TOKENS, EASE } from '@/lib/motion';

// Drift alarm between the CSS motion tokens (src/index.css) and the TS mirrors
// (src/lib/motion/tokens.ts). If either side is edited without the other, the
// assertion below fails and names both files.
const css = readFileSync(fileURLToPath(new URL('../index.css', import.meta.url)), 'utf8');
const tailwind = readFileSync(
  fileURLToPath(new URL('../../tailwind.config.ts', import.meta.url)),
  'utf8',
);

function tokenMs(name: string): number {
  const match = css.match(new RegExp(`--${name}:\\s*(\\d+)ms`));
  if (match === null) {
    throw new Error(`Token --${name} not found in src/index.css`);
  }
  return Number(match[1]);
}

function tokenCurve(name: string): string {
  const match = css.match(new RegExp(`--ease-${name}:\\s*([^;]+);`));
  if (match === null) throw new Error(`Token --ease-${name} not found in src/index.css`);
  return (match[1] ?? '').replace(/\s+/g, '');
}

describe('motion durations', () => {
  it('constants are positive integers', () => {
    for (const [, value] of DURATION_TOKENS) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });

  it('mirror the --dur-* tokens in src/index.css', () => {
    for (const [token, constant] of DURATION_TOKENS) {
      expect(
        tokenMs(token),
        `--${token} in src/index.css must equal its mirror in src/lib/motion/tokens.ts (${constant}ms). Update both together.`,
      ).toBe(constant);
    }
  });

  it('locked values', () => {
    expect(Object.fromEntries(DURATION_TOKENS)).toEqual({
      'dur-fast': 120,
      'dur-base': 160,
      'dur-slow': 200,
      'dur-push': 280,
      'dur-back': 240,
      'dur-grow': 300,
      'dur-grow-back': 260,
      'dur-sheet-in': 320,
      'dur-sheet-out': 240,
      'dur-menu': 160,
      'dur-toast': 320,
      'dur-wipe': 1200,
      'dur-sweep': 1100,
    });
  });

  it('curves mirror the --ease-* tokens', () => {
    for (const [name, value] of Object.entries(EASE)) {
      expect(tokenCurve(name), name).toBe(value.replace(/\s+/g, ''));
    }
    expect(EASE.ios).toBe('cubic-bezier(0.32, 0.72, 0, 1)');
    expect(EASE.move).toBe('cubic-bezier(0.77, 0, 0.175, 1)');
    expect(EASE.pop).toBe('cubic-bezier(0.34, 1.56, 0.64, 1)');
    expect(EASE.unfold).toBe('cubic-bezier(0.4, 0, 0.2, 1)');
  });

  it('unfold (Activity Show more) eases on ease-unfold over dur-grow, never ease-ios (the 12 Nov jerk)', () => {
    const moves = readFileSync(
      fileURLToPath(new URL('./motion/moves.ts', import.meta.url)),
      'utf8',
    );
    const start = moves.indexOf('export function unfold(');
    expect(start).toBeGreaterThan(-1);
    const unfold = moves.slice(start, moves.indexOf('\nexport ', start + 1));
    expect(unfold).toContain('easing: EASE.unfold');
    expect(unfold).toContain('duration: DUR_GROW_MS');
  });

  it('growFromTrigger (menus, popovers) uses ease-enter; pop() keeps ease-pop', () => {
    const moves = readFileSync(
      fileURLToPath(new URL('./motion/moves.ts', import.meta.url)),
      'utf8',
    );
    const body = (name: string): string => {
      const start = moves.indexOf(`export function ${name}(`);
      expect(start, name).toBeGreaterThan(-1);
      const next = moves.indexOf('\nexport ', start + 1);
      return moves.slice(start, next === -1 ? undefined : next);
    };
    expect(body('growFromTrigger')).toContain('easing: EASE.enter');
    expect(body('growFromTrigger')).not.toContain('EASE.pop');
    expect(body('pop')).toContain('easing: EASE.pop');
  });

  it('every token is registered in tailwind.config.ts', () => {
    for (const [token] of DURATION_TOKENS) expect(tailwind, token).toContain(`var(--${token})`);
    for (const name of Object.keys(EASE)) expect(tailwind, name).toContain(`var(--ease-${name})`);
  });
});
