import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Radius roles (CLAUDE.md): controls 8, cards/popovers/menus 12, sheets and
// dialogs 16, pills full. The chat bubble's 18px and its 4px tail are the only
// arbitrary radii, kept as named constants in chat/chat-type.ts. home/ is the
// marketing site with its own stylesheet. Test files only assert on markup.
const ROOT = fileURLToPath(new URL('../components/', import.meta.url));
const ALLOWED = new Set(['chat/chat-type.ts']);
const ALLOWED_DIRS = ['home/'];
const ARBITRARY_RADIUS = /\brounded(?:-[a-z]{1,2})?-\[[0-9.]+px\]/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('no arbitrary radius', () => {
  it('src/components has no rounded-[Npx] outside chat/chat-type.ts and home/', () => {
    const offenders = sourceFiles(ROOT)
      .map((path) => relative(ROOT, path).split(sep).join('/'))
      .filter((rel) => !rel.includes('__tests__/'))
      .filter((rel) => !ALLOWED.has(rel) && !ALLOWED_DIRS.some((d) => rel.startsWith(d)))
      .flatMap((rel) =>
        (readFileSync(join(ROOT, rel), 'utf8').match(ARBITRARY_RADIUS) ?? []).map(
          (cls) => `${rel} ${cls}`,
        ),
      );
    expect(offenders).toEqual([]);
  });

  it('chat-type.ts keeps the bubble radii as named constants: 18 touch, 12 laptop, a 4px tail', async () => {
    const { BUBBLE_SHAPE, BUBBLE_TAIL } = await import('@/components/chat/chat-type');
    expect(BUBBLE_SHAPE).toEqual({ touch: 'rounded-[18px]', laptop: 'rounded-xl' });
    expect(BUBBLE_TAIL).toEqual({ mine: 'rounded-br-[4px]', theirs: 'rounded-bl-[4px]' });
  });
});
