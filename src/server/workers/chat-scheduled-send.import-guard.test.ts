// Guard: the chat-scheduled-send Worker bundle must never reach a browser-only
// module. src/lib/env.ts validates the Vite env at module load and throws in a
// Worker ("Invalid environment configuration"), and src/lib/logger.ts pulls in
// src/lib/sentry.ts and @sentry/react. PR #717 broke the deploy this way
// (worker -> chat/attachments -> asset-upload -> logger -> sentry -> env).
//
// The walk is static: it parses each reachable source file, follows every
// runtime import/export (type-only ones are erased and never bundled) and
// fails with the path that reached a forbidden module.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const ENTRY = join(ROOT, 'src/server/workers/chat-scheduled-send.ts');

const FORBIDDEN_FILES = ['src/lib/env.ts', 'src/lib/sentry.ts', 'src/lib/logger.ts'];
const FORBIDDEN_PACKAGES = ['@sentry/react'];

const EXTENSIONS = ['.ts', '.tsx', '/index.ts', '/index.tsx'];

function resolveFile(base: string): string | null {
  if (/\.tsx?$/.test(base) && existsSync(base)) return base;
  for (const ext of EXTENSIONS) {
    if (existsSync(base + ext)) return base + ext;
  }
  return null;
}

/** A local file for the specifier, a bare package name, or null for a missing local file. */
function resolveSpecifier(
  from: string,
  specifier: string,
): { file: string } | { pkg: string } | null {
  if (specifier.startsWith('.')) {
    const file = resolveFile(resolve(dirname(from), specifier));
    return file === null ? null : { file };
  }
  if (specifier.startsWith('@/')) {
    const file = resolveFile(join(ROOT, 'src', specifier.slice(2)));
    return file === null ? null : { file };
  }
  const workspace = /^@srtdio\/([^/]+)(\/.*)?$/.exec(specifier);
  if (workspace !== null) {
    const name = workspace[1] ?? '';
    const sub = workspace[2] ?? '/index';
    const file = resolveFile(join(ROOT, 'packages', name, 'src', sub));
    return file === null ? null : { file };
  }
  return { pkg: specifier };
}

/** Every runtime module specifier in a source file (static, re-export and dynamic import()). */
function runtimeSpecifiers(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      node.importClause?.isTypeOnly !== true &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      found.push(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      found.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      found.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Breadth-first walk from the entry; each hit is the import chain that reached it. */
function forbiddenChains(entry: string): string[] {
  const forbidden = new Set(FORBIDDEN_FILES.map((f) => join(ROOT, f)));
  const parent = new Map<string, string | null>([[entry, null]]);
  const queue = [entry];
  const hits: string[] = [];
  const chain = (file: string): string[] => {
    const out: string[] = [];
    for (let at: string | null = file; at !== null; at = parent.get(at) ?? null) {
      out.unshift(relative(ROOT, at));
    }
    return out;
  };
  while (queue.length > 0) {
    const file = queue.shift() as string;
    for (const specifier of runtimeSpecifiers(file)) {
      const target = resolveSpecifier(file, specifier);
      if (target === null) continue;
      if ('pkg' in target) {
        if (FORBIDDEN_PACKAGES.some((p) => target.pkg === p || target.pkg.startsWith(`${p}/`))) {
          hits.push([...chain(file), target.pkg].join(' -> '));
        }
        continue;
      }
      if (parent.has(target.file)) continue;
      parent.set(target.file, file);
      if (forbidden.has(target.file)) {
        hits.push(chain(target.file).join(' -> '));
        continue;
      }
      queue.push(target.file);
    }
  }
  return hits;
}

describe('chat-scheduled-send Worker import graph', () => {
  it('reaches no browser-only module (env, sentry, browser logger, @sentry/react)', () => {
    expect(forbiddenChains(ENTRY)).toEqual([]);
  });

  it('the walk itself sees the worker graph (sanity: it reaches chat/attachments)', () => {
    const seen = new Set<string>();
    const queue = [ENTRY];
    while (queue.length > 0) {
      const file = queue.shift() as string;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const specifier of runtimeSpecifiers(file)) {
        const target = resolveSpecifier(file, specifier);
        if (target !== null && 'file' in target) queue.push(target.file);
      }
    }
    expect(seen.has(join(ROOT, 'src/lib/chat/attachments.ts'))).toBe(true);
  });
});
