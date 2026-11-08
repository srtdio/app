import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// CLAUDE.md: "Thread view: no reply gesture or Reply action inside a thread."
// Inside a thread view a right swipe is not taken (swipe core `takes`, no
// movement) and the long-press sheet has no Reply (canReply false). The left
// swipe (Delete) and the main chat's Reply are untouched.

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

const thread = read('../components/chat/MessageThread.tsx');
const menu = read('../components/chat/MessageActionMenu.tsx');
const swipe = read('../lib/chat/swipe-reply.ts');

describe('thread view: no reply gesture or Reply action', () => {
  it('the swipe core can refuse a way at lock (no movement)', () => {
    expect(swipe).toMatch(/takes\?: \(side: SwipeSide\) => boolean/);
    expect(swipe).toMatch(/!takes\(side\)/);
  });

  it('message rows refuse the right swipe inside a thread view', () => {
    expect(thread).toMatch(
      /takes: \(side\) => side !== 'right' \|\| latest\.current\.replyBlocked !== true/,
    );
    expect(thread).toMatch(/replyBlocked=\{props\.threads\?\.viewRootId !== undefined\}/);
  });

  it('the long-press sheet drops Reply inside a thread view', () => {
    expect(thread).toMatch(/canReply=\{props\.threads\?\.viewRootId === undefined\}/);
    expect(menu).toMatch(/if \(props\.canReply !== false\)/);
  });

  it('the left swipe (Delete) stays on every row', () => {
    expect(thread).toMatch(/direction: 'both'/);
    expect(thread).toMatch(/onLeft: \(\) => latest\.current\.onSwipeDelete/);
  });
});
