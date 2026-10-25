import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Words rules from CLAUDE.md (Design rules): zero states are positive, the
// surface is Activity, the date is Due date, and no copy mentions connection
// state. Scans src/components/**/*.tsx except home/** and test-site/**.
const ROOT = fileURLToPath(new URL('../components/', import.meta.url));
const INBOX = fileURLToPath(new URL('../lib/inbox/', import.meta.url));
const EXEMPT_DIRS = ['home/', 'test-site/'];

function sourceFiles(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path, ext);
    return ext.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const FILES = sourceFiles(ROOT, /\.tsx$/)
  .map((path) => relative(ROOT, path).split(sep).join('/'))
  .filter((rel) => !EXEMPT_DIRS.some((d) => rel.startsWith(d)))
  .map((rel) => ({ rel, source: readFileSync(join(ROOT, rel), 'utf8') }));

/** Visible text only: string literals, template literals and JSX text, minus comments. */
function visibleText(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const out: string[] = [];
  for (const m of code.matchAll(
    /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g,
  )) {
    out.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  for (const m of code.matchAll(/>([^<>{}]+)</g)) out.push(m[1] ?? '');
  return out;
}

function offenders(pattern: RegExp, skip: (text: string) => boolean = () => false): string[] {
  return FILES.flatMap(({ rel, source }) =>
    visibleText(source)
      .filter((text) => pattern.test(text) && !skip(text))
      .map((text) => `${rel}: ${text.trim()}`),
  );
}

// Activity toast strings live in src/lib/inbox; items in Assets are files there too.
const INBOX_FILES = sourceFiles(INBOX, /\.tsx?$/).map((path) => ({
  rel: relative(INBOX, path).split(sep).join('/'),
  source: readFileSync(path, 'utf8'),
}));

describe('copy rules', () => {
  it('zero states never open with "Nothing ..."', () => {
    expect(
      offenders(/\bNothing (fits|called|recent|planned|snoozed|open|coming|has been|is waiting)/),
    ).toEqual([]);
  });

  it('no "No matches"', () => {
    expect(offenders(/\bNo matches\b/)).toEqual([]);
  });

  it('the surface is Activity, never Notifications', () => {
    // Identifiers (NotificationsButton, NotificationsPage) are not visible text.
    expect(
      offenders(/\bNotifications\b/, (text) => /^[A-Za-z_$][\w$]*$/.test(text.trim())),
    ).toEqual([]);
  });

  it('the date is Due date, never Pipeline date', () => {
    expect(offenders(/\bPipeline date\b/i)).toEqual([]);
  });

  it('copy never mentions connection state', () => {
    expect(offenders(/You['’]re offline|Reconnecting|Check your connection/i)).toEqual([]);
  });

  it('Activity toasts in src/lib/inbox say "file", never "an asset" or "New asset"', () => {
    const hits = INBOX_FILES.flatMap(({ rel, source }) =>
      visibleText(source)
        .filter((text) => /\ban asset\b|\bNew asset\b/.test(text))
        .map((text) => `lib/inbox/${rel}: ${text.trim()}`),
    );
    expect(hits).toEqual([]);
  });
});
