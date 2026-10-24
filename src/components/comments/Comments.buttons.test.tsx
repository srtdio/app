import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

// The comment panel pulls the chat attachment hook, whose import graph reaches
// the agora-chat browser SDK; mock it so the pure exports load in node.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { ROW_ACTION_CLASS, ROW_ACTION_STATIC_CLASS } from '@/components/comments/Comments';
import { buttonClass } from '@/components/ui/Button';

// Button system regression: every comment row action (Copy, Reply, Resolve,
// the checkpoint checkbox, Confirm) and the Open / All filter is a <Button>,
// 44 tall with the 8px radius, 14 / 500.

const SRC = readFileSync(fileURLToPath(new URL('./Comments.tsx', import.meta.url)), 'utf8');

function tokens(cls: string): string[] {
  return cls.split(/\s+/).filter(Boolean);
}

const BAD = ['h-8', 'h-9', 'h-10', 'h-12', 'rounded-md', 'rounded-xl', 'font-semibold', 'text-xs'];

describe('Comments row actions', () => {
  it('a ghost row action renders 44 tall, 8px radius, 14 / 500, 44 wide minimum', () => {
    const t = tokens(buttonClass('ghost', 'default', ROW_ACTION_CLASS));
    for (const want of [
      'h-11',
      'min-h-[44px]',
      'min-w-[44px]',
      'rounded-lg',
      'text-sm',
      'font-medium',
    ]) {
      expect(t).toContain(want);
    }
    for (const bad of BAD) expect(t).not.toContain(bad);
  });

  it('the row-action layout carries no height, radius, padding or type of its own', () => {
    const t = tokens(ROW_ACTION_CLASS);
    expect(t.some((c) => /^(h-|rounded|px-|text-(xs|sm|base)|font-)/.test(c))).toBe(false);
  });

  it('the passive checkbox matches the button box', () => {
    const t = tokens(ROW_ACTION_STATIC_CLASS);
    for (const want of ['h-11', 'min-h-[44px]', 'px-4', 'text-sm', 'font-medium']) {
      expect(t).toContain(want);
    }
  });

  it('row actions and filters are Buttons, not raw buttons with their own recipe', () => {
    expect(SRC).not.toContain('className={cn(ROW_ACTION_CLASS');
    expect(SRC).toContain('className={ROW_ACTION_CLASS}');
    expect(SRC).toContain("variant={filter === value ? 'secondary' : 'ghost'}");
    expect(SRC).not.toMatch(/<Button[^>]*size="(sm|md|lg)"/);
  });
});
