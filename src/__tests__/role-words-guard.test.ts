import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Roles in visible text (9 Nov 2026): Creator (role key agency), Approver
// (role key client). No string literal in app source may say "agency" or
// "client" as a word in text that has a space (copy, not a key). Role keys,
// column names and ids carry no space ('agency', 'show_to_client',
// 'client_id'), so they pass. Comments are not string literals (the
// TypeScript scanner skips them). Out of scope: src/components/home/** (the
// marketing site), src/server/** (Workers), tests, fixtures and test utils.
//
// KNOWN holds the strings that were already there on 9 Nov 2026 and were left
// on purpose (listed in the PR under COULD NOT RESOLVE). It only shrinks: a
// new offender fails, and so does an entry whose string is gone.

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ROLE_WORD = /\b(agency|client)\b/i;

/** file (relative to src) -> the exact literals allowed there, for now. */
const KNOWN: Record<string, readonly string[]> = {
  'components/chat/IdeaShareFlow.tsx': ['show it to the client'],
  'components/chat/PlanItemScreen.tsx': ['show it to the client'],
  'components/chat/PlanScreen.tsx': ['chat: plan open for client failed'],
  'components/pages/plan-tab/BankList.tsx': ['show it to the client'],
  'components/pages/plan-tab/bank-parts.ts': ['Client can see'],
  'lib/inbox/inbox-live.ts': ['hid an idea from the client'],
  'lib/onboarding.ts': ['Client servicing'],
  'main.tsx': ['home hydration fell back to client render'],
};

function skipped(rel: string): boolean {
  return (
    rel.startsWith('components/home/') ||
    rel.startsWith('server/') ||
    /\.test\.tsx?$/.test(rel) ||
    /(^|\/)__tests__\//.test(rel) ||
    /fixture/i.test(rel) ||
    /(^|\/)test-utils?\//.test(rel)
  );
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Every string literal (and template chunk) in the source that names a role in copy. */
function roleWordLiterals(source: string, fileName: string): string[] {
  if (!ROLE_WORD.test(source)) return [];
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      const text = node.text;
      if (/\s/.test(text) && ROLE_WORD.test(text)) found.push(text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

const FILES = sourceFiles(ROOT)
  .map((path) => ({ path, rel: relative(ROOT, path).split(sep).join('/') }))
  .filter(({ rel }) => !skipped(rel));

describe('role words guard (Creator / Approver in visible text)', () => {
  it('the scanner flags copy, never keys or comments', () => {
    const src = [
      "const key = 'agency';",
      "const col = 'show_to_client';",
      '// the client sees this',
      "const copy = 'Show to client';",
      'const t = `Ask the agency ${x} now`;',
    ].join('\n');
    expect(roleWordLiterals(src, 'probe.ts')).toEqual(['Show to client', 'Ask the agency ']);
  });

  it('no new string literal in src says agency or client as a word', () => {
    const offenders: string[] = [];
    for (const { path, rel } of FILES) {
      const allowed = KNOWN[rel] ?? [];
      for (const text of roleWordLiterals(readFileSync(path, 'utf8'), path)) {
        if (!allowed.includes(text)) offenders.push(`${rel}: ${JSON.stringify(text)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('KNOWN only shrinks: every listed string still exists', () => {
    const stale: string[] = [];
    for (const [rel, texts] of Object.entries(KNOWN)) {
      const file = FILES.find((f) => f.rel === rel);
      const found =
        file === undefined ? [] : roleWordLiterals(readFileSync(file.path, 'utf8'), rel);
      for (const text of texts) if (!found.includes(text)) stale.push(`${rel}: ${text}`);
    }
    expect(stale).toEqual([]);
  });
});
