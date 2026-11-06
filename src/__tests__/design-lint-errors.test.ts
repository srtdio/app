import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// Guard (eslint.config.js): the design rules whose hit count in src/** reached
// zero are errors, never warnings again. Stacking (z-[N]), icon size={N} and
// type overrides (leading-*, tracking-*, text-[..]) error in components and
// ui/; the role table (ui/Text.tsx) may track but never stacks by hand.
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const eslint = new ESLint({ cwd: ROOT });

async function severities(filePath: string, code: string, text: string): Promise<number[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).filter((m) => m.message.includes(text)).map((m) => m.severity);
}

const PAGE = 'src/components/pages/LintErrorsFixture.tsx';
const CHAT = 'src/components/chat/LintErrorsFixture.tsx';
const UI = 'src/components/ui/LintErrorsFixture.tsx';
const TEXT = 'src/components/ui/Text.tsx';

const Z = 'export const A = () => <div className="fixed z-[60]" />;\n';
const ICON =
  "import { IconPlus } from '@/components/ui/icons';\nexport const A = () => <IconPlus size={16} />;\n";
const TYPE = 'export const A = () => <span className="leading-5 tracking-wide" />;\n';

describe('design lint: rules at zero hits are errors', () => {
  for (const file of [PAGE, CHAT, UI]) {
    it(`z-[N] errors in ${file}`, { timeout: 60_000 }, async () => {
      const sev = await severities(file, Z, 'stacking scale');
      expect(sev.length).toBeGreaterThan(0);
      expect(sev.every((s) => s === 2)).toBe(true);
    });

    it(`icon size={N} errors in ${file}`, { timeout: 60_000 }, async () => {
      const sev = await severities(file, ICON, 'ICON_SIZE');
      expect(sev).toEqual([2]);
    });

    it(`leading-* / tracking-* error in ${file}`, { timeout: 60_000 }, async () => {
      const sev = await severities(file, TYPE, 'text role');
      expect(sev.length).toBeGreaterThan(0);
      expect(sev.every((s) => s === 2)).toBe(true);
    });
  }

  it('ui/Text.tsx (the role table) may track, but z-[N] still errors', { timeout: 60_000 }, async () => {
    expect(await severities(TEXT, TYPE, 'text role')).toEqual([]);
    const sev = await severities(TEXT, Z, 'stacking scale');
    expect(sev.length).toBeGreaterThan(0);
    expect(sev.every((s) => s === 2)).toBe(true);
  });

  it('named stacking and type tokens pass', { timeout: 60_000 }, async () => {
    const [result] = await eslint.lintText(
      'export const A = () => <div className="fixed z-sheet text-base" />;\n',
      { filePath: PAGE },
    );
    expect(result?.messages ?? []).toEqual([]);
  });

  it('rules that still have hits stay warnings (raw <img>, placed IconButton, raw input)', {
    timeout: 60_000,
  }, async () => {
    expect(await severities(PAGE, 'export const A = () => <img alt="" />;\n', 'Avatar')).toEqual([
      1,
    ]);
    expect(
      await severities(PAGE, 'export const A = () => <input />;\n', 'ui/Input'),
    ).toEqual([1]);
  });

  it('the config source names the error lists', () => {
    // Static half of the guard: the lists exist and are spread into an error rule.
    const src = readFileSync(`${ROOT}eslint.config.js`, 'utf8');
    expect(src).toContain('const layoutErrors = [');
    expect(src).toContain('const typeErrors = [');
    expect(src).not.toContain('layoutWarnings');
    expect(src).not.toContain('typeWarnings');
    expect(src).toMatch(/'no-restricted-syntax': \[\s*'error',[^\]]*\.\.\.layoutErrors/);
  });
});
