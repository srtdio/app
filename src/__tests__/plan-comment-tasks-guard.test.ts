// Plan and Bank comments get Add to Tasks exactly as post comments (13 Nov
// 2026): the replies bar key and the menu row for creators, post comments'
// CommentTaskSheet on plan_item_comment_task_create, the Task tag under the
// comment, the link read in the comments read itself (no extra read).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(resolve(__dirname, '..', path), 'utf8');

describe('Plan and Bank comment tasks', () => {
  it('the thread offers Add to Tasks on the bar and the menu, creators only', () => {
    const thread = read('components/chat/PlanItemThread.tsx');
    expect(thread).toContain('onTasks: () => setTaskFor(root)');
    expect(thread).toContain(
      'onAddToTasks={taskable(menu.comment) ? (c) => setTaskFor(c) : undefined}',
    );
    expect(thread).toContain('canTask && recorded(c) && taskStateOf(c.taskState) === null');
    expect(thread).toContain('source="plan"');
    expect(thread).toContain('<CommentTaskTag tag={tag} />');
    expect(read('components/chat/PlanItemScreen.tsx')).toContain("canTask={side === 'agency'}");
  });

  it('the write is plan_item_comment_task_create; the link rides in the comments read', () => {
    expect(read('lib/comment-tasks.ts')).toContain(
      "params.source === 'plan' ? 'plan_item_comment_task_create' : 'comment_task_create'",
    );
    expect(read('lib/chat/plans.ts')).toContain(
      'task_state, plan_item_comment_tasks(task_id, channel_id, assignee_user_id, group_name)',
    );
  });
});
