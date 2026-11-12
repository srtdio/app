import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// Guard: list time by meaning, through src/lib/time.ts only. Things that just
// happened read formatAgo ("just now", "5m", "3h", "Yesterday", "Mon", "2 Nov");
// deadlines read formatDue, words only ("Today", "Fri", "12 Nov"), late ones
// formatOverdue ("1d late" / "3w late" / "2mo late" / "1y late"), plans
// formatPlanStart ("Mon" ahead, "Live" while on, "1 Nov" once ended); records read formatAdded
// ("10:27 AM" today, else "2 Nov"). Absolute text only through formatTime /
// formatDayLabel / formatDayRange / the picker helpers. Nothing outside
// src/lib/time.ts calls a locale date formatter, Intl.DateTimeFormat /
// Intl.RelativeTimeFormat or a date-fns format, or hand-rolls an "ago" string.
// formatRelative, formatWhen and formatChatTime are gone, and so are the long
// forms ("5 min ago", "Due in 3 days", "Starts in 9 days", "Overdue 2 days").
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

/** Every .ts/.tsx file under src/**, tests included (but not this guard, which names the dead ones). */
function allFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return allFiles(path);
    return /\.tsx?$/.test(name) && name !== 'time-format-rules.test.ts' ? [path] : [];
  });
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
    for (const name of [
      'format',
      'formatDistance',
      'formatDistanceToNow',
      'formatRelative',
      'intlFormat',
      'lightFormat',
    ]) {
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
    'Intl.DateTimeFormat alias': 'export const F = Intl.DateTimeFormat;\n',
    'Intl.DateTimeFormat call': "export const a = Intl.DateTimeFormat('en-US').format(0);\n",
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

  it('no hand-rolled relative strings: "ago" and "just now" come only from formatAgo', () => {
    expect(offenders(/\bago(['"`]|\s*<\/)/)).toEqual([]);
    expect(offenders(/just now/i)).toEqual([]);
    expect(offenders(/\b(mins?|minutes?|hours?|days?|weeks?|months?|years?) ago\b/)).toEqual([]);
  });

  it('none of the long forms appear in src/** source', () => {
    expect(offenders(/min ago|hours ago|days ago/)).toEqual([]);
    expect(offenders(/Due in /)).toEqual([]);
    expect(offenders(/Starts in /)).toEqual([]);
    expect(offenders(/Overdue \d+ day/)).toEqual([]);
    expect(offenders(/Overdue \$\{[^}]*\} days?/)).toEqual([]);
    const body = code(TIME);
    for (const long of [/min ago/, /hours ago/, /days ago/, /Due in /, /Starts in /]) {
      expect(body).not.toMatch(long);
    }
  });

  it('formatRelative, formatWhen and formatChatTime exist nowhere in src/**', () => {
    expect(TIME).not.toMatch(/\bformat(Relative|When|ChatTime)\b/);
    const hits = allFiles(SRC)
      .filter((path) => /\bformat(Relative|When|ChatTime)\b/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(SRC, path).split(sep).join('/'));
    expect(hits).toEqual([]);
  });

  it('no "Overdue ·" form remains (overdue reads "2d late")', () => {
    expect(code(TIME)).not.toMatch(/Overdue ·/);
    expect(offenders(/Overdue ·/)).toEqual([]);
  });

  it('the card date words never say "Due", "Overdue", "Starts" or "Started" (time.ts)', () => {
    const body = code(TIME);
    expect(body).not.toMatch(/`Due \$\{|'Due today'|'Due tomorrow'/);
    expect(body).not.toMatch(/`Overdue \$\{|'Overdue'/);
    expect(body).not.toMatch(/`Starts? |`Started /);
  });
});

describe('time format rule: src/lib/time.ts is the one rule', () => {
  const exported = [...TIME.matchAll(/^export function (\w+)\(/gm)].map((m) => m[1]);

  it('exports exactly formatAgo, formatDue and formatAdded as the list-time functions', () => {
    // A list-time function reads a moment or a day for a list line; the rest are
    // absolute formatters, zone helpers, and formatDue's late / plan-start forms.
    const LIST_TIME = /^format(Ago|Added|Due|Relative|When|ChatTime|Since|Elapsed|Moment|Age)$/;
    expect(exported.filter((name) => LIST_TIME.test(name ?? '')).sort()).toEqual([
      'formatAdded',
      'formatAgo',
      'formatDue',
    ]);
    expect(exported.sort()).toEqual(
      [
        'civilDay',
        'daysFromToday',
        'deviceTimeZone',
        'formatAdded',
        'formatAgo',
        'formatDate',
        'formatDateTime',
        'formatDateWithYear',
        'formatDayLabel',
        'formatDayRange',
        'formatDue',
        'formatDueDate',
        'formatOverdue',
        'formatPlanStart',
        'formatSpokenDate',
        'formatTime',
        'isValidTimeZone',
        'rowWhen',
        'safeTimeZone',
        'shortZoneName',
        'threadWhen',
        'zonedParts',
      ].sort(),
    );
  });

  it('formatAgo owns the short past words; formatDue the deadline words', () => {
    const body = code(TIME);
    expect(body).toContain("'just now'");
    expect(body).toContain("'Yesterday'");
    expect(body).toContain('`${Math.floor(diff / MINUTE)}m`');
    expect(body).toContain('`${Math.floor(diff / HOUR)}h`');
    expect(body).toContain("'Today'");
    expect(body).toContain("'Tomorrow'");
    expect(body).toContain('`${late} late`');
    expect(body).toContain("'Live'");
    expect(body).toContain('`${months}mo`');
  });
});
