import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Screen reader rules, read from the source (no DOM):
//  1. Every ui/Input, Textarea and Select in src/components has a name:
//     aria-label / aria-labelledby (Select: its `label` prop, which becomes the
//     trigger's aria-label), or an id a label points at (inside a <Field>,
//     whose label links to the id it hands the control, or a <label htmlFor>
//     naming the same id), or it sits inside a <label> element.
//  2. Every role="menu" carries aria-label or aria-labelledby.
//  3. ui/Chip announces its state itself: aria-pressed on a toggle chip,
//     role="tab" + aria-selected on a tab chip. Call sites pass `selected`
//     (and `tab` inside a tablist) and never hand-roll it.
// Test files are skipped: they assert on rendered markup, not author it.
const ROOT = fileURLToPath(new URL('../components/', import.meta.url));

// Usages that are named another way the scan cannot see, each with its reason.
// Keep this small; prefer an aria-label at the site.
const UNNAMED_ALLOW: ReadonlyMap<string, string> = new Map([]);

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsxFiles(path);
    return name.endsWith('.tsx') ? [path] : [];
  });
}

/** Block comments and whole-line // or * comments blanked (line numbers kept). */
function stripComments(src: string): string {
  const noBlocks = src.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '));
  return noBlocks
    .split('\n')
    .map((line) => (/^\s*(\/\/|\*)/.test(line) ? '' : line))
    .join('\n');
}

const FILES: { rel: string; src: string }[] = tsxFiles(ROOT)
  .map((path) => ({ path, rel: relative(ROOT, path).split(sep).join('/') }))
  .filter(({ rel }) => !/\.test\.tsx$/.test(rel))
  .map(({ path, rel }) => ({ rel, src: stripComments(readFileSync(path, 'utf8')) }));

/** The JSX opening tag starting at `start`, up to its closing `>` outside any `{...}`. */
function openingTag(src: string, start: number): string {
  let depth = 0;
  for (let i = start; i < src.length; i += 1) {
    const c = src[i];
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    else if (c === '>' && depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
}

/** Whether `at` sits inside an open <Tag ...> ... </Tag> (the last open before it is not closed). */
function insideElement(src: string, at: number, tag: string): boolean {
  const before = src.slice(0, at);
  const open = before.search(new RegExp(`<${tag}\\b(?![\\s\\S]*<${tag}\\b)`));
  if (open < 0) return false;
  return !before.slice(open).includes(`</${tag}>`);
}

function lineOf(src: string, index: number): number {
  return src.slice(0, index).split('\n').length;
}

const NAMED = /\saria-label(ledby)?=|['"]aria-label(ledby)?['"]\s*:/;

/** "file:line Tag" for each Input / Textarea / Select with no accessible name. */
export function unnamedFields(rel: string, src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/<(Input|Textarea|Select)(?=[\s/>])/g)) {
    const tag = openingTag(src, m.index);
    if (NAMED.test(tag)) continue;
    if (m[1] === 'Select' && /\slabel=/.test(tag)) continue;
    if (insideElement(src, m.index, 'label')) continue;
    const id = /\sid=(\{[^}]*\}|"[^"]*")/.exec(tag)?.[1];
    if (id !== undefined) {
      if (insideElement(src, m.index, 'Field')) continue;
      if (src.includes(`htmlFor=${id}`)) continue;
    }
    out.push(`${rel}:${lineOf(src, m.index)} ${m[1]}`);
  }
  return out;
}

/** "file:line" for each role="menu" (JSX or a props object) with no aria-label(ledby). */
export function unnamedMenus(rel: string, src: string): string[] {
  const out: string[] = [];
  // JSX attribute (never a [role="menu"] selector string).
  for (const m of src.matchAll(/(?<=\s)role="menu"/g)) {
    const start = src.lastIndexOf('<', m.index);
    const tag = start < 0 ? '' : openingTag(src, start);
    if (!NAMED.test(tag)) out.push(`${rel}:${lineOf(src, m.index)}`);
  }
  // Props object: { role: 'menu', 'aria-label': ... }.
  for (const m of src.matchAll(/\brole:\s*'menu'/g)) {
    const open = src.lastIndexOf('{', m.index);
    const close = src.indexOf('}', m.index);
    const obj = src.slice(open, close < 0 ? undefined : close + 1);
    if (!/['"]aria-label(ledby)?['"]\s*:/.test(obj)) out.push(`${rel}:${lineOf(src, m.index)}`);
  }
  return out;
}

describe('a11y rules', () => {
  it('every ui/Input, Textarea and Select has an accessible name', () => {
    const offenders = FILES.flatMap(({ rel, src }) => unnamedFields(rel, src)).filter(
      (hit) => !UNNAMED_ALLOW.has(hit.split(':')[0] ?? ''),
    );
    expect(offenders).toEqual([]);
  });

  it('every role="menu" carries aria-label or aria-labelledby', () => {
    expect(FILES.flatMap(({ rel, src }) => unnamedMenus(rel, src))).toEqual([]);
  });

  it('ui/Chip announces selected itself: aria-pressed, or role="tab" + aria-selected', () => {
    const chip = FILES.find(({ rel }) => rel === 'ui/Chip.tsx')?.src ?? '';
    expect(chip).toContain("'aria-pressed': selected");
    expect(chip).toContain("role: 'tab', 'aria-selected'");
    // Spread before the call site's props, so the Chip's state is always there.
    expect(chip).toMatch(/\{\.\.\.chipStateAria\([^)]*\)\}\s*\{\.\.\.props\}/);
  });

  it('in-page tabs (shell/Tabs) are role="tab" + aria-selected, never aria-current="page"', () => {
    const tabs = FILES.find(({ rel }) => rel === 'shell/Tabs.tsx')?.src ?? '';
    expect(tabs).toContain('role="tablist"');
    expect(tabs).toContain('role="tab"');
    expect(tabs).toContain('aria-selected={isActive}');
    expect(tabs).not.toContain('aria-current');
  });

  it('the scans catch what they should', () => {
    expect(unnamedFields('x.tsx', '<Input value={v} />')).toEqual(['x.tsx:1 Input']);
    expect(unnamedFields('x.tsx', '<Input aria-label="Search" />')).toEqual([]);
    expect(unnamedFields('x.tsx', '<Select label="Format" value={v} />')).toEqual([]);
    expect(unnamedFields('x.tsx', '<Field label="A">{(id) => <Input id={id} />}</Field>')).toEqual(
      [],
    );
    expect(unnamedFields('x.tsx', '<label htmlFor="a">A</label><Input id="a" />')).toEqual([]);
    expect(unnamedFields('x.tsx', '<Input id="b" />')).toEqual(['x.tsx:1 Input']);
    expect(unnamedFields('x.tsx', '<label>A <Input /></label>')).toEqual([]);
    expect(unnamedMenus('x.tsx', '<div role="menu">')).toEqual(['x.tsx:1']);
    expect(unnamedMenus('x.tsx', '<div role="menu" aria-label="Sort">')).toEqual([]);
    expect(unnamedMenus('x.tsx', 'const s = \'[role="menu"]\';')).toEqual([]);
    expect(unnamedMenus('x.tsx', "{...{ role: 'menu', 'aria-label': label }}")).toEqual([]);
  });
});
