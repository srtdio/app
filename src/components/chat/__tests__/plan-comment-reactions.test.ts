import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { planCommentMessage, type ShownComment } from '@/components/chat/PlanItemThread';

const SRC = readFileSync(resolve(__dirname, '../PlanItemThread.tsx'), 'utf8');

const comment: ShownComment = {
  id: 'p1',
  authorUserId: 'a',
  authorName: 'Ana',
  mine: false,
  body: 'Looks good',
  visibility: 'everyone',
  createdAt: '2026-11-09T10:00:00Z',
  pending: false,
};

describe('plan comment reactions', () => {
  it("a plan comment carries its thread's reactions into chat's bubble", () => {
    const reactions = [{ emoji: '👍', count: 2, mine: true }];
    expect(planCommentMessage(comment, reactions).reactions).toEqual(reactions);
    expect(planCommentMessage(comment).reactions).toEqual([]);
  });

  it('reads plan_item_comment reactions once per thread (batched), and the menu reacts', () => {
    expect(SRC).toContain("kind: 'plan-comment'");
    expect(SRC.match(/useReactions\(/g)?.length).toBe(1);
    expect(SRC).not.toContain('canReact={false}');
    expect(SRC).toContain('props.reactions.toggle(c.id, emoji)');
  });
});
