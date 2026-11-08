// Comment to task, chat side: a task made from a post or brief comment reads
// its source off the list read's comment_tasks embed, and its row line says
// `From a comment on "<title>"` and opens that comment's deep link (the same
// link Reply privately opens). Clients get no embed (RLS), so no line.

import { describe, expect, it } from 'vitest';
import type { Client } from '@srtdio/rpc';
import {
  TASK_LIST_SELECT,
  missingSourceIds,
  readChannelTasks,
  readSourceTitles,
  rowToTask,
  sourceTitleKey,
  taskSourceLink,
  taskSourceOf,
  taskSourceText,
  type TaskCommentSource,
} from '@/lib/chat/tasks';
import { privateReplyHref } from '@/lib/chat/private-reply';

const row = {
  id: 't1',
  channel_id: 'c1',
  workspace_id: 'w1',
  number: 4,
  title: 'Fix the caption',
  side: 'agency',
  status: 'todo',
  priority: 1,
  due_on: null,
  done_at: null,
  created_by: 'u1',
  created_at: '2026-11-08T09:00:00Z',
  updated_at: '2026-11-08T09:00:00Z',
  deleted_at: null,
};

const postSource: TaskCommentSource = { commentId: 'cm1', entityType: 'post', entityId: 'p1' };

describe('taskSourceOf (the comment_tasks embed)', () => {
  it('reads a post or brief comment off the one to one object', () => {
    expect(
      taskSourceOf({ comment_id: 'cm1', comments: { entity_type: 'post', entity_id: 'p1' } }),
    ).toEqual(postSource);
    expect(
      taskSourceOf({ comment_id: 'cm2', comments: { entity_type: 'brief', entity_id: 'b1' } }),
    ).toEqual({ commentId: 'cm2', entityType: 'brief', entityId: 'b1' });
  });

  it('takes an array answer too (first item)', () => {
    expect(
      taskSourceOf([{ comment_id: 'cm1', comments: [{ entity_type: 'post', entity_id: 'p1' }] }]),
    ).toEqual(postSource);
  });

  it('is null with no link (clients: RLS hides comment_tasks), a hidden comment or another entity', () => {
    expect(taskSourceOf(null)).toBeNull();
    expect(taskSourceOf(undefined)).toBeNull();
    expect(taskSourceOf([])).toBeNull();
    expect(taskSourceOf({ comment_id: 'cm1', comments: null })).toBeNull();
    expect(
      taskSourceOf({ comment_id: 'cm1', comments: { entity_type: 'asset', entity_id: 'a1' } }),
    ).toBeNull();
    expect(
      taskSourceOf({ comment_id: '', comments: { entity_type: 'post', entity_id: 'p1' } }),
    ).toBeNull();
    expect(
      taskSourceOf({ comment_id: 'cm1', comments: { entity_type: 'post', entity_id: 7 } }),
    ).toBeNull();
  });
});

describe('rowToTask with the embed', () => {
  it('maps the source onto the task', () => {
    const task = rowToTask({
      ...row,
      comment_tasks: { comment_id: 'cm1', comments: { entity_type: 'post', entity_id: 'p1' } },
    } as never);
    expect(task?.source).toEqual(postSource);
    expect(task?.title).toBe('Fix the caption');
  });

  it('a row with no link (or no embed at all) has no source', () => {
    expect(rowToTask({ ...row, comment_tasks: null } as never)?.source).toBeNull();
    expect(rowToTask(row as never)?.source).toBeNull();
  });
});

describe('the source line', () => {
  it('says From a comment on "<title>" with straight quotes and no em-dash', () => {
    const text = taskSourceText('post', 'Launch reel');
    expect(text).toBe('From a comment on "Launch reel"');
    expect(text).not.toMatch(/[\u2014\u201c\u201d]/);
    expect(taskSourceText('brief', '  Spring brief ')).toBe('From a comment on "Spring brief"');
  });

  it('an empty title names the kind instead', () => {
    expect(taskSourceText('post', '  ')).toBe('From a comment on a post');
    expect(taskSourceText('brief', '')).toBe('From a comment on a brief');
  });

  it('links to the comment exactly as Reply privately does', () => {
    const titles = new Map([[sourceTitleKey(postSource), 'Launch reel']]);
    const link = taskSourceLink(postSource, titles);
    expect(link).toEqual({
      text: 'From a comment on "Launch reel"',
      href: '/posts/p1?comment=cm1',
    });
    expect(link?.href).toBe(
      privateReplyHref({ kind: 'comment', entityType: 'post', entityId: 'p1', commentId: 'cm1' }),
    );
    const brief: TaskCommentSource = { commentId: 'c 2', entityType: 'brief', entityId: 'b1' };
    expect(taskSourceLink(brief, new Map([['brief:b1', 'Spring']]))?.href).toBe(
      '/briefs/b1?comment=c%202',
    );
  });

  it('is null with no source, or before the title is known', () => {
    expect(taskSourceLink(null, new Map())).toBeNull();
    expect(taskSourceLink(undefined, new Map())).toBeNull();
    expect(taskSourceLink(postSource, new Map())).toBeNull();
  });
});

describe('missingSourceIds', () => {
  it('lists the post and brief ids not yet known, deduped', () => {
    const tasks = [
      { source: postSource },
      { source: { ...postSource, commentId: 'cm9' } },
      { source: { commentId: 'cm3', entityType: 'brief' as const, entityId: 'b1' } },
      { source: { commentId: 'cm4', entityType: 'post' as const, entityId: 'p2' } },
      { source: null },
      {},
    ];
    expect(missingSourceIds(tasks, (key) => key === 'post:p2')).toEqual({
      postIds: ['p1'],
      briefIds: ['b1'],
    });
  });
});

/** A recording fake of the query builder slice the reads use, per table. */
function fakeClient(answers: Record<string, { data: unknown; error: { message: string } | null }>) {
  const calls: { table: string; method: string; args: unknown[] }[] = [];
  const client = {
    from: (table: string) => {
      const answer = answers[table] ?? { data: [], error: null };
      const query = {
        select: (...args: unknown[]) => (calls.push({ table, method: 'select', args }), query),
        eq: (...args: unknown[]) => (calls.push({ table, method: 'eq', args }), query),
        is: (...args: unknown[]) => (calls.push({ table, method: 'is', args }), query),
        in: (...args: unknown[]) => (calls.push({ table, method: 'in', args }), query),
        then: (resolve: (v: unknown) => void) => resolve(answer),
      };
      calls.push({ table, method: 'from', args: [] });
      return query;
    },
  };
  return { client: client as unknown as Client, calls };
}

describe('reads', () => {
  it('the list read embeds the comment link in the same one query', async () => {
    const { client, calls } = fakeClient({
      chat_tasks: {
        data: [
          {
            ...row,
            comment_tasks: {
              comment_id: 'cm1',
              comments: { entity_type: 'post', entity_id: 'p1' },
            },
          },
        ],
        error: null,
      },
    });
    const res = await readChannelTasks(client, 'c1');
    expect(res.ok && res.data[0]?.source).toEqual(postSource);
    expect(calls.filter((c) => c.method === 'from')).toHaveLength(1);
    const select = calls.find((c) => c.method === 'select');
    expect(select?.args[0]).toBe(TASK_LIST_SELECT);
    expect(TASK_LIST_SELECT).toContain(
      'comment_tasks(comment_id, comments(entity_type, entity_id))',
    );
  });

  it('reads titles with two IN reads of id, title; none for no ids', async () => {
    const { client, calls } = fakeClient({
      posts: { data: [{ id: 'p1', title: 'Launch reel' }], error: null },
      briefs: { data: [{ id: 'b1', title: 'Spring' }], error: null },
    });
    const none = await readSourceTitles(client, { postIds: [], briefIds: [] });
    expect(none.ok && none.data.size).toBe(0);
    expect(calls).toHaveLength(0);
    const res = await readSourceTitles(client, { postIds: ['p1'], briefIds: ['b1'] });
    expect(res.ok && [...res.data]).toEqual([
      ['post:p1', 'Launch reel'],
      ['brief:b1', 'Spring'],
    ]);
    expect(calls.filter((c) => c.method === 'select').map((c) => c.args[0])).toEqual([
      'id, title',
      'id, title',
    ]);
    expect(calls.filter((c) => c.method === 'in').map((c) => [c.table, c.args])).toEqual([
      ['posts', ['id', ['p1']]],
      ['briefs', ['id', ['b1']]],
    ]);
  });

  it('a failed title read fails the answer (asked again later)', async () => {
    const { client } = fakeClient({ posts: { data: null, error: { message: 'boom' } } });
    const res = await readSourceTitles(client, { postIds: ['p1'], briefIds: [] });
    expect(res.ok).toBe(false);
  });
});
