import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Loading shells use the same lit-* class as the card that replaces them
// (CLAUDE.md Lighting; docs/lighting.md). Bone and BoxSkeleton
// (src/lib/motion/react.tsx) take a required `lit` prop, the lit height of what
// lands in their place ('flat' for text lines and plain rows), and render it.
// Every call site passes it; lit-coverage.test.ts checks the value is a height.
// Every hit prints as file:line.
const SRC = fileURLToPath(new URL('../', import.meta.url));
const REACT = readFileSync(join(SRC, 'lib/motion/react.tsx'), 'utf8');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

// Every source file outside the module that defines the shells.
const FILES = sources(SRC)
  .map((path) => relative(SRC, path).split(sep).join('/'))
  .filter((rel) => !rel.startsWith('lib/motion/') && !rel.startsWith('server/'))
  .filter((rel) => !/\.test\.tsx?$/.test(rel) && !rel.includes('__tests__/'))
  .map((rel) => ({ rel, src: readFileSync(join(SRC, rel), 'utf8') }));

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

/** Every <Bone / <BoxSkeleton opening tag: file, line and its top-level attributes. */
function shellCalls(): { where: string; attrs: string }[] {
  const out: { where: string; attrs: string }[] = [];
  for (const { rel, src } of FILES) {
    for (const m of src.matchAll(/<(Bone|BoxSkeleton)\b/g)) {
      const attrs = topLevel(openingTag(src, m.index));
      out.push({ where: `${rel}:${lineOf(src, m.index)}`, attrs });
    }
  }
  return out;
}

describe('shell rules', () => {
  it('Bone and BoxSkeleton take a required lit prop and render it', () => {
    const props = (name: string): string =>
      new RegExp(`interface ${name} [^{]*\\{([\\s\\S]*?)\\n\\}`).exec(REACT)?.[1] ?? '';
    for (const name of ['BoneProps', 'BoxSkeletonProps']) {
      // Required: `lit: BoneLit;`, never `lit?:`.
      expect(props(name), name).toMatch(/\n\s*lit: BoneLit;/);
    }
    expect(REACT).toMatch(/export function Bone\(\{\s*lit\b/);
    expect(REACT).toMatch(/export function BoxSkeleton\(\{\s*lit\b/);
    // The class comes from the prop, so the shell lights like what replaces it.
    expect(REACT.split('boneLitClass(lit)').length - 1).toBeGreaterThanOrEqual(2);
  });

  it('there are shell call sites to check (the scan is reading the code)', () => {
    expect(shellCalls().length).toBeGreaterThan(10);
  });

  it('every <Bone and <BoxSkeleton call passes lit= (a spread never hides it)', () => {
    const missing = shellCalls()
      .filter(({ attrs }) => !/\slit=/.test(attrs))
      .map(({ where }) => where);
    expect(missing).toEqual([]);
  });
});
