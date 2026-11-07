import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Swipe (CLAUDE.md): right = Reply, left = Delete on every message, comment
// and task row; one core (src/lib/chat/swipe-reply.ts); own and others' rows
// swipe the same. Each surface builds its gesture from that one controller.
const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

describe('swipe rules', () => {
  it.each([
    'components/chat/MessageThread.tsx',
    'components/chat/tasks/TaskRow.tsx',
    'components/comments/Comments.tsx',
  ])('%s swipes through the one core', (rel) => {
    expect(read(rel)).toContain("from '@/lib/chat/swipe-reply'");
    expect(read(rel)).toContain('createSwipeReplyController(');
  });

  it('messages and comments swipe both ways; tasks swipe left only', () => {
    expect(read('components/chat/MessageThread.tsx')).toMatch(/direction:\s*'both'/);
    expect(read('components/comments/Comments.tsx')).toMatch(/direction:\s*'both'/);
    expect(read('components/chat/tasks/TaskRow.tsx')).toMatch(/direction:\s*'left'/);
  });

  it('CLAUDE.md carries the rule', () => {
    const doc = readFileSync(fileURLToPath(new URL('../../CLAUDE.md', import.meta.url)), 'utf8');
    expect(doc).toContain('Swipe: right = Reply, left = Delete');
    expect(doc).toContain('never merge with E2E WebKit red');
  });
});
