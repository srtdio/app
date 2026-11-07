// Guard: the vertical spacing rule (CLAUDE.md "Spacing", 8 Nov 2026). Padding,
// margin, gap and space take 4 / 8 / 12 / 16 / 24 only (plus 32 and up, the
// field-y and row-inset tokens). The off-steps 0.5 (2), 1.5 (6), 5 (20) and
// 7 (28) stay in width / height only, so tailwind.config.ts no longer builds
// them for spacing and no class in src/** uses them.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import resolveConfig from 'tailwindcss/resolveConfig';
import tailwindConfig from '../../tailwind.config';

const resolved = resolveConfig(tailwindConfig).theme as unknown as Record<
  string,
  Record<string, string>
>;
const OFF = ['0.5', '1.5', '2.5', '3.5', '5', '7'];

describe('spacing steps: tailwind lock', () => {
  for (const key of ['padding', 'margin', 'gap', 'space'] as const) {
    it(`${key} has no off-step (0.5, 1.5, 5, 7)`, () => {
      const keys = Object.keys(resolved[key] ?? {});
      for (const off of OFF) expect(keys).not.toContain(off);
      for (const on of ['1', '2', '3', '4', '6', '8']) expect(keys).toContain(on);
    });
  }

  it('width and height keep every size (0.5, 1.5, 5, 7)', () => {
    for (const key of ['width', 'height'] as const) {
      const keys = Object.keys(resolved[key] ?? {});
      for (const kept of ['0.5', '1.5', '5', '7']) expect(keys).toContain(kept);
    }
  });

  it('the two named insets: field-y (10) and row-inset (10, the Compact row)', () => {
    expect(resolved.padding?.['field-y']).toBe('0.625rem');
    expect(resolved.padding?.['row-inset']).toBe('0.625rem');
  });
});

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__snapshots__') continue;
      out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx|css)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const OFF_STEP_CLASS =
  /(?<![\w\-./[])-?(?:p[trblxyse]?|m[trblxyse]?|gap-[xy]|gap|space-[xy])-(?:0\.5|1\.5|2\.5|3\.5|5|7)(?![\w.\-/\]])/g;

describe('spacing steps: src/** uses none of the off-steps', () => {
  it('no p/m/gap/space 0.5, 1.5, 2.5, 3.5, 5 or 7 class in app code', () => {
    const hits: string[] = [];
    for (const file of sourceFiles(fileURLToPath(new URL('../', import.meta.url)))) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(OFF_STEP_CLASS)) hits.push(`${file}: ${m[0]}`);
    }
    expect(hits).toEqual([]);
  });
});
