// Guard (CLAUDE.md, 9 Nov 2026): "Catch up: one card per item; card swipe = X
// axis + rotate only." The catch-up sources never move a card on Y, the lean
// is capped at 6deg, and the queue is keyed per ITEM (every entry of a post,
// brief, plan item, idea, chat or thread rides one card). Cards live only in
// Catch up (an Activity row opens the real place), are read only (no edit, no
// resolve), carry the name row menu without Mute or Star, Mark as read is
// never green, and the card surface differs from the page in both themes.

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

  it('one card per item: two comments on one post are one card', () => {
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
    const queue = buildCatchUpQueue({
      tapped: null,
      held: [row('a', 'p1'), row('bb', 'p1'), row('c', 'p2')],
      nowMs: 0,
      workspaceId: 'ws',
    });
    expect(queue.map((i) => i.key)).toEqual(['post:p1', 'post:p2']);
    expect(queue[0]?.entries.map((e) => e.id)).toEqual(['bb', 'a']);
  });

  it('cards live only in Catch up: an Activity row tap opens the real place', () => {
    const page = readFileSync(join(SRC, 'components/pages/NotificationsPage.tsx'), 'utf8');
    expect(page).not.toMatch(/\(entry: ActivityItem\) => openCatchUp\(entry\)/);
    expect(page).toContain('onClick={() => openCatchUp(null)}');
  });

  it('read-only cards: no edit, resolve or delete write in catch up', () => {
    const offenders = FILES.filter(({ src }) =>
      /\b(editComment|resolveComment|deleteComment|comment_resolve|post_update)\b/.test(src),
    ).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('the name row menu: Open and Copy link, never Mute or Star; Mark as read is never green', () => {
    const all = FILES.map((f) => f.src).join('\n');
    expect(all).not.toMatch(/['"`](Mute|Star)['"`]/);
    expect(all).not.toMatch(/variant="success"/);
    const screen = FILES.find((f) => f.rel === 'components/catch-up/CatchUpScreen.tsx')?.src ?? '';
    expect(screen).toContain("label: 'Copy link'");
    expect(screen).toContain('openLabel(item.kind)');
  });

  it('card and page are distinct surfaces in both themes', () => {
    const css = readFileSync(join(SRC, 'index.css'), 'utf8');
    const bg = (selector: string): string =>
      new RegExp(`${selector.replace(/[.]/g, '\\.')}\\s*\\{[^}]*background-color:\\s*([^;]+);`).exec(css)?.[1]?.trim() ?? '';
    const light = { card: bg('\n  .catch-up-card'), page: bg('\n  .catch-up-page') };
    const dark = { card: bg('.dark .catch-up-card'), page: bg('.dark .catch-up-page') };
    expect(light.card).not.toBe('');
    expect(dark.card).not.toBe('');
    expect(light.card).not.toBe(light.page);
    expect(dark.card).not.toBe(dark.page);
  });

  it('CLAUDE.md carries the rule', () => {
    const md = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8');
    expect(md).toContain('Catch up: one card per item; card swipe = X axis + rotate only.');
  });
});
