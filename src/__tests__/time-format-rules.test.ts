import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// Guard: ONE past-time format app-wide (src/lib/time.ts formatWhen: "10:27 AM"
// today, "Yesterday", "Mon", "19 Oct", "19 Oct 2025"). Every visible date or
// time reads through src/lib/time.ts; nothing outside it calls a locale date
// formatter, Intl.DateTimeFormat / Intl.RelativeTimeFormat or a date-fns
// format, and nothing reads relative ("5 min ago", "just now").
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SRC = join(ROOT, 'src');
const CONFIG = readFileSync(join(ROOT, 'eslint.config.js'), 'utf8');
const TIME = readFileSync(join(SRC, 'lib/time.ts'), 'utf8');

// Mirrors TIME_IGNORES in eslint.config.js (tests are skipped by sourceFiles).
const EXEMPT_FILES = new Set(['lib/time.ts', 'server/cron/catchup-schedule.ts']);
const EXEMPT_DIRS = ['components/home/'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Source with comments removed, so a code comment that says "ago" is no hit. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

const FILES = sourceFiles(SRC)
  .map((path) => relative(SRC, path).split(sep).join('/'))
  .filter((rel) => !EXEMPT_FILES.has(rel) && !EXEMPT_DIRS.some((d) => rel.startsWith(d)))
  .map((rel) => ({ rel, text: code(readFileSync(join(SRC, rel), 'utf8')) }));

function offenders(pattern: RegExp): string[] {
  return FILES.filter((f) => pattern.test(f.text)).map((f) => f.rel);
}

describe('time format rule: eslint.config.js', () => {
  it('bans locale/Intl date formatters as an error', () => {
    expect(CONFIG).toContain("'time/no-date-format': ['error', ...timeFormatRules]");
    expect(CONFIG).toContain('toLocale(Date|Time)?String');
    expect(CONFIG).toContain('DateTimeFormat|RelativeTimeFormat');
  });

  it('bans the date-fns format family as an error', () => {
    expect(CONFIG).toContain("'no-restricted-imports': ['error', timeFormatImports]");
    for (const name of ['format', 'formatDistance', 'formatDistanceToNow', 'formatRelative']) {
      expect(CONFIG).toContain(`'${name}'`);
    }
  });

  it('exempts only src/lib/time.ts, tests and the named zone-maths files', () => {
    const ignores = CONFIG.slice(
      CONFIG.indexOf('const TIME_IGNORES = ['),
      CONFIG.indexOf('];', CONFIG.indexOf('const TIME_IGNORES = [')),
    );
    expect(ignores).toContain("'src/lib/time.ts'");
    expect(ignores).not.toContain("'src/lib/**'");
    expect(ignores).not.toContain("'src/components/**'");
  });
});

describe('time format rule: lint severities', () => {
  const eslint = new ESLint({ cwd: ROOT });
  const FIXTURE = 'src/components/pages/TimeFormatFixture.tsx';

  async function severities(filePath: string, source: string): Promise<number[]> {
    const [result] = await eslint.lintText(source, { filePath });
    return (result?.messages ?? [])
      .filter((m) => m.message.includes('src/lib/time.ts'))
      .map((m) => m.severity);
  }

  const CASES: Record<string, string> = {
    toLocaleDateString: 'export const a = new Date().toLocaleDateString();\n',
    toLocaleTimeString: 'export const a = new Date().toLocaleTimeString();\n',
    toLocaleString: 'export const a = new Date().toLocaleString();\n',
    'Intl.DateTimeFormat': "export const a = new Intl.DateTimeFormat('en-US');\n",
    'Intl.RelativeTimeFormat': "export const a = new Intl.RelativeTimeFormat('en');\n",
    'date-fns format': "import { format } from 'date-fns';\nexport const a = format;\n",
    'date-fns formatDistanceToNow':
      "import { formatDistanceToNow } from 'date-fns';\nexport const a = formatDistanceToNow;\n",
  };

  for (const [name, source] of Object.entries(CASES)) {
    it(`${name} is an error outside src/lib/time.ts`, { timeout: 60_000 }, async () => {
      const sev = await severities(FIXTURE, source);
      expect(sev.length).toBeGreaterThan(0);
      expect(sev.every((s) => s === 2)).toBe(true);
    });
  }

  it('src/lib/time.ts may use Intl.DateTimeFormat', { timeout: 60_000 }, async () => {
    expect(await severities('src/lib/time.ts', CASES['Intl.DateTimeFormat']!)).toEqual([]);
  });

  it('counts use Intl.NumberFormat, which passes', { timeout: 60_000 }, async () => {
    const source = "export const a = new Intl.NumberFormat('en-US').format(1234);\n";
    expect(await severities(FIXTURE, source)).toEqual([]);
  });
});

describe('time format rule: source scan of src/**', () => {
  it('no locale date formatter or Intl date/relative format outside src/lib/time.ts', () => {
    expect(
      offenders(/\.toLocale(Date|Time)?String\(|Intl\.(DateTimeFormat|RelativeTimeFormat)\b/),
    ).toEqual([]);
  });

  it('no date-fns format imports', () => {
    expect(
      offenders(
        /import\s*\{[^}]*\bformat(Distance|DistanceToNow|Relative)?\b[^}]*\}\s*from\s*['"]date-fns|from\s*['"]date-fns\/format/,
      ),
    ).toEqual([]);
  });

  it('no relative user strings ("5 min ago", "2 days ago", "just now")', () => {
    expect(offenders(/\bago(['"`]|\s*<\/)/)).toEqual([]);
    expect(offenders(/just now/i)).toEqual([]);
    expect(offenders(/\b(mins?|minutes?|hours?|days?|weeks?|months?|years?) ago\b/)).toEqual([]);
  });

  it('src/lib/time.ts has no relative helper', () => {
    expect(TIME).not.toMatch(/export function formatRelative\b/);
    expect(code(TIME)).not.toMatch(/\bago['"`]|just now/);
    expect(TIME).toContain('export function formatWhen(');
  });
});
