import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { avatarShapeClass, AVATAR_PX, type AvatarRole } from '@/components/ui/Avatar';

// L2 (8 Nov 2026): people take the same rounded-square shape as groups and
// workspaces at every size; one shape rule lives in ui/Avatar. Guard: no
// avatar face or avatar skeleton (lit-avatar) is drawn round anywhere in src,
// except the presence dot inside ui/Avatar itself.
const ROOT = fileURLToPath(new URL('../', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === '__tests__' || name === 'node_modules' ? [] : sourceFiles(path);
    }
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

/** "file:line" for each line that draws a lit-avatar round. Pure. */
export function roundAvatarUses(rel: string, src: string): string[] {
  return src.split('\n').flatMap((line, i) => {
    if (!/lit-avatar/.test(line) || !/\brounded-full\b/.test(line)) return [];
    if (rel === 'components/ui/Avatar.tsx' && /data-presence|bg-good/.test(line)) return [];
    return [`${rel}:${i + 1}`];
  });
}

describe('square people avatars (L2)', () => {
  it('one shape rule: every role is a rounded square', () => {
    for (const role of Object.keys(AVATAR_PX) as AvatarRole[]) {
      expect(avatarShapeClass(role)).toMatch(/^rounded-(lg|xl)$/);
    }
  });

  it('no lit-avatar face or skeleton is drawn round in src', () => {
    const hits = sourceFiles(ROOT).flatMap((path) =>
      roundAvatarUses(relative(ROOT, path).split(sep).join('/'), readFileSync(path, 'utf8')),
    );
    expect(hits).toEqual([]);
  });

  it('flags a hand-built round avatar', () => {
    expect(
      roundAvatarUses('x.tsx', '<Bone lit="lit-avatar" className="h-8 w-8 rounded-full" />'),
    ).toEqual(['x.tsx:1']);
  });
});
