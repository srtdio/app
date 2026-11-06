// Claude Code PostToolUse hook (.claude/settings.json) for Edit | Write | MultiEdit.
// Reads the hook JSON from stdin, takes tool_input.file_path and, for a .ts/.tsx
// file under src/, runs the design ratchet's per-file checks plus eslint on it.
// A violation that the same file on origin/main does not already have is
// printed to stderr with the shared part or token to use, and the hook exits 2
// so Claude Code fixes it in the same task. Anything else exits 0.
//
// Budget: under 2 s per file. eslint gets whatever time the scan leaves; when
// it would run over, it is skipped (and the hook says so). CI still lints.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isScanned, METRICS, scanSource, type Hit } from './design-ratchet.ts';

const BUDGET_MS = 2000;

export interface EslintMessage {
  line: number;
  ruleId: string | null;
  message: string;
  severity: number;
}

export interface HookDeps {
  root: string;
  /** Current file contents, or null when it no longer exists. */
  readCurrent: (rel: string) => string | null;
  /** The file on origin/main; '' when it is new. */
  readBase: (rel: string) => string;
  /** Other files' hits for a distinct metric value check; null = not checked. */
  usedElsewhere?: (hit: Hit) => boolean | null;
  /** eslint messages, or null when skipped. */
  eslint?: (rel: string, msLeft: number) => EslintMessage[] | null;
  now?: () => number;
}

export interface HookResult {
  code: 0 | 2;
  stderr: string[];
}

function keyOf(h: Hit): string {
  return `${h.metric}\u0000${h.value}`;
}

/** Hits in `next` that `prev` does not account for (multiset, line numbers ignored). */
export function newHits(prev: Hit[], next: Hit[]): Hit[] {
  const budget = new Map<string, number>();
  for (const h of prev) budget.set(keyOf(h), (budget.get(keyOf(h)) ?? 0) + 1);
  const fresh: Hit[] = [];
  const seenDistinct = new Set<string>();
  for (const h of next) {
    const k = keyOf(h);
    if (METRICS[h.metric].distinct) {
      // A distinct value counts once: new only if the old file never had it.
      if ((budget.get(k) ?? 0) > 0 || seenDistinct.has(k)) continue;
      seenDistinct.add(k);
      fresh.push(h);
      continue;
    }
    const left = budget.get(k) ?? 0;
    if (left > 0) budget.set(k, left - 1);
    else fresh.push(h);
  }
  return fresh;
}

function relPath(root: string, filePath: string): string {
  const abs = isAbsolute(filePath) ? filePath : join(root, filePath);
  return relative(root, abs).split(sep).join('/');
}

export function runHook(stdin: string, deps: HookDeps): HookResult {
  const now = deps.now ?? (() => Date.now());
  const start = now();
  const stderr: string[] = [];
  let filePath: unknown;
  try {
    const input = JSON.parse(stdin) as { tool_input?: { file_path?: unknown } };
    filePath = input.tool_input?.file_path;
  } catch {
    return { code: 0, stderr };
  }
  if (typeof filePath !== 'string') return { code: 0, stderr };
  const rel = relPath(deps.root, filePath);
  if (!isScanned(rel)) return { code: 0, stderr };
  const current = deps.readCurrent(rel);
  if (current === null) return { code: 0, stderr };

  const fresh = newHits(scanSource(rel, deps.readBase(rel)), scanSource(rel, current)).filter(
    // A distinct value already used in another file is not new; when the
    // lookup runs out of time (null) CI's full ratchet decides instead.
    (h) => !METRICS[h.metric].distinct || !deps.usedElsewhere || deps.usedElsewhere(h) === false,
  );

  for (const h of fresh) {
    const meta = METRICS[h.metric];
    stderr.push(`${h.file}:${h.line}  ${h.metric}: ${h.value}  (${meta.what})`);
    stderr.push(`  Use instead: ${meta.fix}`);
  }

  let lintErrors = 0;
  if (deps.eslint) {
    const left = BUDGET_MS - (now() - start);
    const messages = left > 300 ? deps.eslint(rel, left) : null;
    if (messages === null) {
      stderr.push(
        `(design hook: eslint skipped for ${rel}, over the ${BUDGET_MS} ms budget; CI lints it)`,
      );
    } else {
      for (const m of messages) {
        if (m.severity < 2) continue;
        lintErrors++;
        stderr.push(`${rel}:${m.line}  eslint ${m.ruleId ?? ''}: ${m.message}`);
      }
    }
  }

  if (fresh.length === 0 && lintErrors === 0) {
    // Only the skip note (if any) is worth showing; exit 0 keeps the task moving.
    return { code: 0, stderr };
  }
  stderr.unshift(
    'Design rules (CLAUDE.md Layout rules): this edit adds a new violation. Fix it in this task; never raise scripts/design-ratchet.baseline.json.',
  );
  return { code: 2, stderr };
}

// ---------------------------------------------------------------- real deps

function gitShow(root: string, rel: string): string {
  try {
    return execFileSync('git', ['show', `origin/main:${rel}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return '';
  }
}

/** Is a distinct value (z-10, a card padding set...) already used in another src file? */
function usedElsewhereIn(root: string, deadline: number): (hit: Hit) => boolean | null {
  return (hit) => {
    const needle =
      hit.metric === 'zValues'
        ? hit.value
        : hit.metric === 'iconSizes'
          ? (hit.value.split(':')[0] ?? hit.value)
          : hit.metric === 'cardPadding'
            ? (hit.value.split(' ')[0] ?? hit.value)
            : 'rounded-full';
    let files: string[];
    try {
      files = execFileSync('git', ['grep', '-l', '-F', needle, '--', 'src'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .split('\n')
        .filter((f) => f && f !== hit.file && isScanned(f));
    } catch {
      return false;
    }
    for (const f of files) {
      if (Date.now() > deadline) return null;
      const src = existsSync(join(root, f)) ? readFileSync(join(root, f), 'utf8') : '';
      if (scanSource(f, src).some((h) => h.metric === hit.metric && h.value === hit.value)) {
        return true;
      }
    }
    return false;
  };
}

function eslintFile(root: string): (rel: string, msLeft: number) => EslintMessage[] | null {
  return (rel, msLeft) => {
    const bin = join(root, 'node_modules', '.bin', 'eslint');
    if (!existsSync(bin)) return null;
    try {
      const out = execFileSync(bin, ['--format', 'json', rel], {
        cwd: root,
        encoding: 'utf8',
        timeout: msLeft,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return parseEslint(out);
    } catch (e) {
      const err = e as { stdout?: string; signal?: string | null };
      // eslint exits 1 when it finds errors; stdout still holds the report.
      if (err.signal || !err.stdout) return null;
      return parseEslint(err.stdout);
    }
  };
}

function parseEslint(out: string): EslintMessage[] {
  const report = JSON.parse(out) as Array<{ messages: EslintMessage[] }>;
  return report.flatMap((r) => r.messages);
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const start = Date.now();
  const stdin = readFileSync(0, 'utf8');
  const result = runHook(stdin, {
    root,
    readCurrent: (rel) =>
      existsSync(join(root, rel)) ? readFileSync(join(root, rel), 'utf8') : null,
    readBase: (rel) => gitShow(root, rel),
    usedElsewhere: usedElsewhereIn(root, start + 1200),
    eslint: eslintFile(root),
  });
  for (const line of result.stderr) process.stderr.write(`${line}\n`);
  process.exitCode = result.code;
}
