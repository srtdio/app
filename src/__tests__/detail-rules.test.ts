import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// PR C detail rules: one breakpoint, one avatar API, one count pill, IconSend
// only on the composers' send buttons, one long-press duration. Reads every
// src/components/**/*.ts(x) except home/ (marketing pages) and test-site/ (a
// staff-only harness) and test files. Static text scans: comments count too.
const ROOT = fileURLToPath(new URL('../components/', import.meta.url));
const LIB = fileURLToPath(new URL('../lib/', import.meta.url));
const SKIPPED_DIRS = ['home/', 'test-site/'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

const FILES: { rel: string; src: string }[] = sourceFiles(ROOT)
  .map((path) => ({ path, rel: relative(ROOT, path).split(sep).join('/') }))
  .filter(
    ({ rel }) => !/\.test\.tsx?$/.test(rel) && !SKIPPED_DIRS.some((dir) => rel.startsWith(dir)),
  )
  .map(({ path, rel }) => ({ rel, src: readFileSync(path, 'utf8') }));

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

/** The tag with every `{...}` emptied, so only its own attribute names remain. */
function topLevel(tag: string): string {
  let depth = 0;
  let out = '';
  for (const c of tag) {
    if (c === '{') {
      if (depth === 0) out += c;
      depth += 1;
    } else if (c === '}') {
      depth -= 1;
      if (depth === 0) out += c;
    } else if (depth === 0) out += c;
  }
  return out;
}

function lineOf(src: string, index: number): number {
  return src.slice(0, index).split('\n').length;
}

function indexesOf(src: string, re: RegExp): number[] {
  const out: number[] = [];
  const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  for (let m = global.exec(src); m !== null; m = global.exec(src)) out.push(m.index);
  return out;
}

describe('detail rules: one breakpoint', () => {
  // Phone vs laptop is useIsLaptop()/isLaptopNow() (width >= 768, iPad is
  // laptop); pointer, motion and viewport reads use the helpers beside it.
  it('src/lib/use-is-laptop.ts exists and exports useIsLaptop', () => {
    const path = join(LIB, 'use-is-laptop.ts');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toMatch(/export function useIsLaptop\b/);
  });

  it('no matchMedia, innerWidth or useMediaQuery in src/components', () => {
    const offenders: string[] = [];
    for (const { rel, src } of FILES) {
      for (const at of indexesOf(src, /matchMedia|innerWidth|useMediaQuery|use-media-query/)) {
        offenders.push(`${rel}:${lineOf(src, at)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('detail rules: one avatar API', () => {
  // <Avatar role kind name src presence />: the role sets the size and the kind
  // the shape. The old size and shape props are gone.
  it('no <Avatar> passes size= or shape=', () => {
    const offenders: string[] = [];
    for (const { rel, src } of FILES) {
      for (const start of indexesOf(src, /<Avatar\b/)) {
        const tag = topLevel(openingTag(src, start));
        if (/\s(?:size|shape)=/.test(tag)) offenders.push(`${rel}:${lineOf(src, start)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('detail rules: one count pill', () => {
  // Every unread or pending count renders through ui/CountBadge. A hand-built
  // pill is an element whose className is rounded-full (inline, or through a
  // string constant in the same file) and whose own text renders a count:
  // {countBadgeText(...)}, {unread}, {count}, {unreadCount}, {props.count},
  // {x > 99 ? ...}, or a variable assigned from countBadgeText/unreadPillText.
  // Filter chip counts are plain text, not rounded-full elements of their own.
  const COUNT_BADGE_FILE = 'ui/CountBadge.tsx'; // the one place the pill is drawn
  const COUNT_TEXT =
    /\{\s*(?:countBadgeText\(|[\w.]*(?:unread|count|pending)\w*\s*(?:\}|>\s*99|\?))/i;
  const ROUNDED = /\brounded-full\b/;

  it(`no rounded-full element renders a count outside ${COUNT_BADGE_FILE}`, () => {
    const offenders: string[] = [];
    for (const { rel, src } of FILES) {
      if (rel === COUNT_BADGE_FILE) continue;
      const roundedConsts = [
        ...src.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*(['"`])([\s\S]*?)\2/g),
      ]
        .filter((m) => ROUNDED.test(m[3] ?? ''))
        .map((m) => m[1] ?? '');
      const countVars = [
        ...src.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*(?:countBadgeText|unreadPillText)\(/g),
      ].map((m) => m[1] ?? '');
      for (const start of indexesOf(src, /<[A-Za-z]\w*\b/)) {
        const tag = openingTag(src, start);
        if (tag.endsWith('/>')) continue;
        const rounded =
          ROUNDED.test(tag) || roundedConsts.some((name) => new RegExp(`\\b${name}\\b`).test(tag));
        if (!rounded) continue;
        // The element's own text: up to its first child tag or its closing tag.
        const after = src.slice(start + tag.length);
        const end = after.search(/<\/?[A-Za-z]/);
        const text = end === -1 ? after : after.slice(0, end);
        const counts =
          COUNT_TEXT.test(text) ||
          countVars.some((name) => new RegExp(`\\{\\s*${name}\\s*\\}`).test(text));
        if (counts) offenders.push(`${rel}:${lineOf(src, start)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('detail rules: IconSend only sends a message or comment', () => {
  // Forward and Send to chat use IconForward, Send for review IconArrowUpRight.
  const COMPOSER_FILES = new Set([
    'ui/icons.tsx', // where the icon lives
    'chat/Composer.tsx', // the chat composer's send button
    'chat/VoiceDraft.tsx', // the chat composer's voice-note send button
    'comments/CommentComposer.tsx', // the comment composer's send button
    'comments/SlotComposer.tsx', // the per-slide comment composer's send button
  ]);

  it('IconSend appears only in the composer files', () => {
    const offenders = FILES.filter(
      ({ rel, src }) => !COMPOSER_FILES.has(rel) && /\bIconSend\b/.test(src),
    ).map(({ rel, src }) => `${rel}:${lineOf(src, src.search(/\bIconSend\b/))}`);
    expect(offenders).toEqual([]);
  });
});

describe('detail rules: one long-press duration', () => {
  const LONG_PRESS_FILE = 'ui/useLongPress.ts';
  // A setTimeout with a literal 300..1000 ms delay near press/hold words is a
  // hand-rolled long-press. Allowed, by file and delay, with the reason:
  const TIMER_ALLOWED: Record<string, string> = {
    'chat/Composer.tsx:400':
      'swallowTrailingClick: eats the click that trails a long-press for 400ms after the finger lifts; not a hold duration',
  };
  const PRESS_WORDS = /press|hold|pointerdown|longpress/i;

  it(`${LONG_PRESS_FILE} exports LONG_PRESS_MS and useMenuGesture`, () => {
    const src = readFileSync(join(ROOT, LONG_PRESS_FILE), 'utf8');
    expect(src).toMatch(/export const LONG_PRESS_MS\s*=\s*\d+/);
    expect(src).toMatch(/export function useMenuGesture\b/);
  });

  it('no HOLD_MS or *PRESS*_MS constant outside useLongPress.ts', () => {
    const offenders: string[] = [];
    for (const { rel, src } of FILES) {
      if (rel === LONG_PRESS_FILE) continue;
      for (const at of indexesOf(src, /\b(?:[A-Z0-9_]*PRESS[A-Z0-9_]*_MS|HOLD_MS)\s*=(?!=)/)) {
        offenders.push(`${rel}:${lineOf(src, at)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no setTimeout with a hold-length literal near press/hold handling', () => {
    const offenders: string[] = [];
    for (const { rel, src } of FILES) {
      if (rel === LONG_PRESS_FILE) continue;
      const lines = src.split('\n');
      for (const start of indexesOf(src, /\bsetTimeout\s*\(/)) {
        // The call's last top-level argument is the delay.
        let depth = 0;
        let lastComma = -1;
        let i = src.indexOf('(', start) + 1;
        for (; i < src.length; i += 1) {
          const c = src[i] ?? '';
          if ('([{'.includes(c)) depth += 1;
          else if (')]}'.includes(c)) {
            if (depth === 0) break;
            depth -= 1;
          } else if (c === ',' && depth === 0) lastComma = i;
        }
        if (lastComma === -1) continue;
        const delay = src.slice(lastComma + 1, i).trim();
        if (!/^\d+$/.test(delay)) continue;
        const ms = Number(delay);
        if (ms < 300 || ms > 1000) continue;
        if (TIMER_ALLOWED[`${rel}:${ms}`] !== undefined) continue;
        const line = lineOf(src, start);
        const around = lines.slice(Math.max(0, line - 21), line + 20).join('\n');
        if (PRESS_WORDS.test(around)) offenders.push(`${rel}:${line} (${ms}ms)`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
