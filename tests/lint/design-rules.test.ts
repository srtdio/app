// Guard: the design-rules lint selectors in eslint.config.js fire on app code
// (raw <button>, raw px sizes) and stay quiet on token classes.

import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cwd = fileURLToPath(new URL('../..', import.meta.url));
// A path under src/** that is outside ui/, home/ and the baseline list.
const filePath = 'src/components/pages/DesignRulesFixture.tsx';

async function lint(code: string): Promise<ESLint.LintResult> {
  const eslint = new ESLint({ cwd });
  const [result] = await eslint.lintText(code, { filePath });
  return result;
}

describe('lint: design rules', () => {
  it('flags a raw <button> and text-[13px]', { timeout: 60_000 }, async () => {
    const result = await lint(
      'export function Bad() {\n  return <button className="text-[13px]">Go</button>;\n}\n',
    );
    expect(result.messages.map((m) => m.message)).toEqual([
      'Use Button, IconButton or Chip from src/components/ui',
      'Design rules: tokens and scale only (see CLAUDE.md)',
    ]);
    expect(result.errorCount).toBe(2);
  });

  it('passes token classes and text-legacy-*', { timeout: 60_000 }, async () => {
    const result = await lint(
      'export function Good() {\n  return <span className="text-legacy-sm text-fg-3 bg-bad/10">Go</span>;\n}\n',
    );
    expect(result.messages).toEqual([]);
    expect(result.errorCount).toBe(0);
  });
});
