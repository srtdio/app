import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

// The comment panel pulls the chat attachment hook, whose import graph reaches
// the agora-chat browser SDK; mock it so the pure exports load in node.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import {
  COMMENT_ACTIONS_ROW_CLASS,
  ROW_ACTION_CLASS,
  ROW_ACTION_STATIC_CLASS,
} from '@/components/comments/Comments';
import { buttonClass } from '@/components/ui/Button';

// Button system regression: every comment row action (Reply, Resolve, Confirm,
// View earlier replies) is a ghost <Button>: a 44 hit (44 tall, 44 wide
// minimum, 8px radius) with the visible word at meta size (12 / 500).

const SRC = readFileSync(fileURLToPath(new URL('./Comments.tsx', import.meta.url)), 'utf8');

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

  it('the passive "Open" word matches the button box', () => {
    const t = tokens(ROW_ACTION_STATIC_CLASS);
    for (const want of ['h-11', 'min-h-11', 'min-w-11', 'text-sm', 'font-medium']) {
      expect(t).toContain(want);
    }
  });

  it('the action line is one flex line of 44 boxes', () => {
    const t = tokens(COMMENT_ACTIONS_ROW_CLASS);
    for (const want of ['flex', 'items-center']) expect(t).toContain(want);
  });

  it('row actions and filters are Buttons, not raw buttons with their own recipe', () => {
    expect(SRC).toContain('className={ROW_ACTION_CLASS}');
    expect(SRC).toContain("variant={filter === value ? 'secondary' : 'ghost'}");
    expect(SRC).not.toMatch(/<Button[^>]*size="(sm|md|lg)"/);
  });
});
