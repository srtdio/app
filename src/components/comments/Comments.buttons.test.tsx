import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

// The comment panel pulls the chat attachment hook, whose import graph reaches
// the agora-chat browser SDK; mock it so the pure exports load in node.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { ROW_ACTION_CLASS } from '@/components/comments/Comments';
import { COMMENT_BAR_CLASS } from '@/components/comments/CommentActionBar';
import { buttonClass } from '@/components/ui/Button';

// Button system regression. The text row action left (View earlier replies) is
// a ghost <Button>: a 44 hit (44 tall, 44 wide minimum, 8px radius) with the
// visible word at meta size (12 / 500). Every per-comment action sits on the
// comment's action bar (8 Nov 2026): IconButtons (44 boxes) in a 36 pill.

const SRC = readFileSync(fileURLToPath(new URL('./Comments.tsx', import.meta.url)), 'utf8');
const BAR = readFileSync(fileURLToPath(new URL('./CommentActionBar.tsx', import.meta.url)), 'utf8');

function tokens(cls: string): string[] {
  return cls.split(/\s+/).filter(Boolean);
}

describe('Comments row actions', () => {
  it('a ghost row action keeps the 44 hit and 8px radius, with small type', () => {
    const t = tokens(buttonClass('ghost', 'default', ROW_ACTION_CLASS));
    for (const want of ['h-11', 'min-h-11', 'min-w-11', 'rounded-lg', 'text-sm', 'font-medium']) {
      expect(t).toContain(want);
    }
    expect(t).not.toContain('text-base');
    for (const bad of ['h-8', 'h-9', 'h-10', 'rounded-md', 'rounded-xl', 'font-semibold']) {
      expect(t).not.toContain(bad);
    }
  });

  it('the action bar is a 36 pill, hairline framed, absolute on the row, half above it', () => {
    const t = tokens(COMMENT_BAR_CLASS);
    expect(t).not.toContain('self-start');
    for (const want of [
      'flex',
      'h-9',
      'items-center',
      '-translate-y-1/2',
      'absolute',
      'right-0',
      'top-0',
      'border',
      'rounded-lg',
    ]) {
      expect(t).toContain(want);
    }
    for (const bad of ['shadow', 'shadow-sm', 'backdrop-blur']) expect(t).not.toContain(bad);
  });

  it('every bar control is a 44 IconButton (no raw buttons, no hover reveal)', () => {
    expect(BAR).not.toMatch(/<button\b/);
    expect(BAR.match(/<IconButton\b/g)?.length).toBe(5);
    expect(BAR).not.toMatch(/group-hover|hover:opacity|opacity-0/);
  });

  it('row actions are Buttons, not raw buttons with their own recipe', () => {
    expect(SRC).toContain('cn(ROW_ACTION_CLASS,');
    expect(SRC).not.toContain("variant={filter === value ? 'secondary' : 'ghost'}");
    expect(SRC).not.toMatch(/<Button[^>]*size="(sm|md|lg)"/);
    expect(SRC).toContain('<CommentActionBar');
  });
});
