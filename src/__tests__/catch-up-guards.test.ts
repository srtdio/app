// Guard (CLAUDE.md): "Catch up: one card per notification; card swipe = X
// axis + rotate only." The catch-up sources never move a card on Y, the lean
// is capped at 6deg, and the queue is keyed per inbox entry (never a digest
// group).

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SWIPE_ROTATE_MAX, swipeTransform } from '@/lib/catch-up/card-swipe';
import { buildCatchUpQueue } from '@/lib/catch-up/queue';
import { mapEntry } from '@/components/pages/activity/data';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const FILES = [
  ...sources(join(SRC, 'components/catch-up')),
  ...sources(join(SRC, 'lib/catch-up')),
].map((path) => ({
  rel: relative(SRC, path).split(sep).join('/'),
  src: readFileSync(path, 'utf8'),
}));

describe('catch-up guards', () => {
  it('scans the catch-up sources', () => {
    expect(FILES.map((f) => f.rel)).toEqual(
      expect.arrayContaining([
        'components/catch-up/CatchUpScreen.tsx',
        'components/catch-up/CatchUpCard.tsx',
        'lib/catch-up/card-swipe.ts',
        'lib/catch-up/queue.ts',
      ]),
    );
  });

  it('never moves a card on Y (no translateY, translate3d or translate())', () => {
    const offenders = FILES.flatMap(({ rel, src }) =>
      src
        .split('\n')
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .filter(({ line }) => /translateY|translate3d|translate\(|axis:\s*\[[^\]]*'y'/.test(line))
        .map(({ i }) => `${rel}:${i + 1}`),
    );
    expect(offenders).toEqual([]);
  });

  it('leans at most 6deg', () => {
    expect(SWIPE_ROTATE_MAX).toBeLessThanOrEqual(6);
    const deg = Number(/rotate\((-?[\d.]+)deg\)/.exec(swipeTransform(10_000, 300))?.[1]);
    expect(deg).toBe(6);
  });

  it('one card per notification: the queue holds entries, never groups', () => {
    const row = (id: string, entityId: string) =>
      mapEntry({
        id,
        workspace_id: 'ws',
        user_id: 'me',
        event_type: 'comment',
        entity_type: 'post',
        entity_id: entityId,
        scope: 'posts',
        scope_key: null,
        tier: 'active',
        created_at: `2026-11-08T10:0${id.length}:00Z`,
        read_at: null,
        snoozed_until: null,
        deleted_at: null,
        email_sent_at: null,
        payload: {},
        actor_user_id: null,
      });
    // Two comments on the same post are two cards (Activity groups them; catch up never does).
    const queue = buildCatchUpQueue({
      tapped: null,
      held: [row('a', 'p1'), row('bb', 'p1')],
      nowMs: 0,
      workspaceId: 'ws',
    });
    expect(queue.map((i) => i.id)).toEqual(['bb', 'a']);
    const queueSrc = FILES.find((f) => f.rel === 'lib/catch-up/queue.ts')?.src ?? '';
    expect(queueSrc).not.toMatch(/groupDigest|entityKey/);
  });

  it('CLAUDE.md carries the rule', () => {
    const md = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8');
    expect(md).toContain('Catch up: one card per notification; card swipe = X axis + rotate only.');
  });
});
