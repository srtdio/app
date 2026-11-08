import { describe, expect, it, vi } from 'vitest';
import type { CommentTaskEmbed } from '@srtdio/comments';
import type { ChannelSummary } from '@/lib/chat-reads';
import type { MentionCandidate } from '@/lib/workspace-members';
import { TASK_TITLE_MAX } from '@/lib/chat/tasks';

// The module graph reaches the app client; nothing here talks to it.
vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  ME_LABEL,
  TASK_ASSIGNED,
  TASK_DONE,
  addTaskFailed,
  barHasButtons,
  commentBar,
  commentTaskTag,
  createCommentTask,
  isAgencyRole,
  localTaskLink,
  parseTaskCreate,
  resolveSlot,
  sameTarget,
  taskChannelId,
  taskGroups,
  taskPeople,
  taskRoute,
  taskStateOf,
  taskTitleFrom,
  type CommentBarInput,
} from '@/lib/comment-tasks';

// Comment to task (8 Nov 2026): the comment's action bar, its task tag and the
// To-do sheet's target, as pure rules.

const WS = 'ws-1';
const ME = 'u-me';
const ANA = 'u-ana';
const CLIENT = 'u-client';

const base: CommentBarInput = {
  canReply: true,
  resolve: null,
  viewerIsAgency: false,
  hasTask: false,
  canEdit: false,
  canDelete: false,
};

describe('isAgencyRole / taskStateOf', () => {
  it('owner, admin and agency are agency side; client and unknown are not', () => {
    for (const role of ['owner', 'admin', 'agency']) expect(isAgencyRole(role)).toBe(true);
    for (const role of ['client', '', null, undefined]) expect(isAgencyRole(role)).toBe(false);
  });

  it('reads only assigned and done', () => {
    expect(taskStateOf('assigned')).toBe('assigned');
    expect(taskStateOf('done')).toBe('done');
    expect(taskStateOf(null)).toBeNull();
    expect(taskStateOf(undefined)).toBeNull();
    expect(taskStateOf('other')).toBeNull();
  });
});

describe('commentBar: who sees what', () => {
  it("agency on someone else's comment: Reply, Resolve, To-do; no Edit, no Delete", () => {
    const bar = commentBar({ ...base, resolve: 'resolve', viewerIsAgency: true });
    expect(bar).toEqual({
      reply: true,
      resolve: 'resolve',
      todo: true,
      edit: false,
      delete: false,
    });
  });

  it('agency on its own comment: Edit and Delete too', () => {
    const bar = commentBar({
      ...base,
      resolve: 'resolve',
      viewerIsAgency: true,
      canEdit: true,
      canDelete: true,
    });
    expect(bar).toEqual({ reply: true, resolve: 'resolve', todo: true, edit: true, delete: true });
  });

  it("a client on someone else's comment: Reply only (no To-do ever)", () => {
    const bar = commentBar({ ...base, resolve: null, viewerIsAgency: false });
    expect(bar).toEqual({ reply: true, resolve: null, todo: false, edit: false, delete: false });
  });

  it('a client on its own comment: Reply, Edit, Delete; still no To-do', () => {
    const bar = commentBar({ ...base, canEdit: true, canDelete: true });
    expect(bar.todo).toBe(false);
    expect(bar.edit).toBe(true);
    expect(bar.delete).toBe(true);
  });

  it('To-do hides once the comment has a task', () => {
    expect(commentBar({ ...base, viewerIsAgency: true, hasTask: true }).todo).toBe(false);
  });

  it('a frozen own checkpoint withholds Edit and Delete', () => {
    const bar = commentBar({ ...base, canEdit: false, canDelete: false, viewerIsAgency: true });
    expect(bar.edit).toBe(false);
    expect(bar.delete).toBe(false);
  });

  it('a bar with nothing to show is empty', () => {
    expect(barHasButtons(commentBar({ ...base, canReply: false }))).toBe(false);
    expect(barHasButtons(commentBar(base))).toBe(true);
  });
});

describe('resolveSlot: exactly where resolving is allowed today', () => {
  it('a reply never resolves', () => {
    expect(
      resolveSlot({
        reply: true,
        point: false,
        isClient: false,
        resolved: false,
        confirmed: false,
      }),
    ).toBeNull();
  });

  it('a plain thread: agency Resolve, Reopen once resolved; a client none', () => {
    const thread = { reply: false, point: false, confirmed: false };
    expect(resolveSlot({ ...thread, isClient: false, resolved: false })).toBe('resolve');
    expect(resolveSlot({ ...thread, isClient: false, resolved: true })).toBe('reopen');
    expect(resolveSlot({ ...thread, isClient: true, resolved: false })).toBeNull();
    expect(resolveSlot({ ...thread, isClient: true, resolved: true })).toBeNull();
  });

  it('a checkpoint: agency Resolve while open; a client Confirm on a resolved, unconfirmed point', () => {
    const point = { reply: false, point: true };
    expect(resolveSlot({ ...point, isClient: false, resolved: false, confirmed: false })).toBe(
      'resolve',
    );
    expect(resolveSlot({ ...point, isClient: false, resolved: true, confirmed: false })).toBeNull();
    expect(resolveSlot({ ...point, isClient: true, resolved: true, confirmed: false })).toBe(
      'confirm',
    );
    expect(resolveSlot({ ...point, isClient: true, resolved: true, confirmed: true })).toBeNull();
    expect(resolveSlot({ ...point, isClient: true, resolved: false, confirmed: false })).toBeNull();
  });
});

describe('commentTaskTag: text per role and state', () => {
  const names: Record<string, string> = { [ANA]: 'Ana Silva', [ME]: 'Mia Me' };
  const nameOf = (id: string): string | null => names[id] ?? null;
  const toAna: CommentTaskEmbed = {
    task_id: 't-1',
    channel_id: 'dm-1',
    assignee_user_id: ANA,
    group_name: null,
  };

  it('no task: no tag', () => {
    expect(
      commentTaskTag({ state: null, link: null, viewerIsAgency: true, me: ME, nameOf }),
    ).toBeNull();
  });

  it('agency: "Task · {first name}", grey, opens the chat task', () => {
    expect(
      commentTaskTag({ state: 'assigned', link: toAna, viewerIsAgency: true, me: ME, nameOf }),
    ).toEqual({ text: 'Task · Ana', tone: 'neutral', href: '/chat?channel=dm-1&task=t-1' });
  });

  it('agency, done: "Task done · {first name}" in the good token', () => {
    expect(
      commentTaskTag({ state: 'done', link: toAna, viewerIsAgency: true, me: ME, nameOf }),
    ).toEqual({ text: 'Task done · Ana', tone: 'good', href: '/chat?channel=dm-1&task=t-1' });
  });

  it('agency: my own task reads "Task · You"', () => {
    const mine = { ...toAna, channel_id: 'notes__ws-1__u-me', assignee_user_id: ME };
    expect(
      commentTaskTag({ state: 'assigned', link: mine, viewerIsAgency: true, me: ME, nameOf })?.text,
    ).toBe('Task · You');
  });

  it('agency: a group task reads "Task · {group}"', () => {
    const group = { ...toAna, channel_id: 'g-1', assignee_user_id: null, group_name: 'Design' };
    expect(
      commentTaskTag({ state: 'assigned', link: group, viewerIsAgency: true, me: ME, nameOf })
        ?.text,
    ).toBe('Task · Design');
  });

  it('agency without a known name or link: the plain words', () => {
    const unknown = { ...toAna, assignee_user_id: 'u-gone' };
    expect(
      commentTaskTag({ state: 'assigned', link: unknown, viewerIsAgency: true, me: ME, nameOf })
        ?.text,
    ).toBe(TASK_ASSIGNED);
    expect(
      commentTaskTag({ state: 'done', link: null, viewerIsAgency: true, me: ME, nameOf }),
    ).toEqual({ text: TASK_DONE, tone: 'good', href: null });
  });

  it('a client: "Task assigned" / "Task done", never a name, never a link', () => {
    expect(
      commentTaskTag({ state: 'assigned', link: toAna, viewerIsAgency: false, me: ME, nameOf }),
    ).toEqual({ text: 'Task assigned', tone: 'neutral', href: null });
    expect(
      commentTaskTag({ state: 'done', link: null, viewerIsAgency: false, me: ME, nameOf }),
    ).toEqual({ text: 'Task done', tone: 'good', href: null });
  });
});

describe('the To-do sheet', () => {
  const candidates: MentionCandidate[] = [
    { id: ME, name: 'Mia Me', username: 'mia', role: 'owner', avatarUrl: null },
    { id: 'u-zed', name: 'Zed Admin', username: null, role: 'admin', avatarUrl: null },
    { id: ANA, name: 'Ana Silva', username: 'ana', role: 'agency', avatarUrl: null },
    { id: CLIENT, name: 'Cara Client', username: 'cara', role: 'client', avatarUrl: null },
  ];

  it('people are agency side only, me left out (Me is its own chip), by name', () => {
    expect(taskPeople(candidates, ME).map((p) => [p.id, p.firstName])).toEqual([
      [ANA, 'Ana'],
      ['u-zed', 'Zed'],
    ]);
    expect(ME_LABEL).toBe('Me');
  });

  it('groups are the group chats on the device, by name', () => {
    const roster = [
      { channelId: 'g-2', channelType: 'group', title: 'Social' },
      { channelId: 'dm-1', channelType: 'dm', title: 'Ana Silva' },
      { channelId: 'g-1', channelType: 'group', title: 'Design' },
    ] as ChannelSummary[];
    expect(taskGroups(roster)).toEqual([
      { channelId: 'g-1', name: 'Design' },
      { channelId: 'g-2', name: 'Social' },
    ]);
  });

  it('the title is the plain comment text, one line, at most 200', () => {
    expect(taskTitleFrom('**Fix** the\n\n_hook_ line')).toBe('Fix the hook line');
    expect(taskTitleFrom('x'.repeat(300))).toHaveLength(TASK_TITLE_MAX);
  });

  it('one pick: the same chip twice is the same target', () => {
    expect(sameTarget({ kind: 'me' }, { kind: 'me' })).toBe(true);
    expect(sameTarget({ kind: 'person', userId: ANA }, { kind: 'person', userId: ANA })).toBe(true);
    expect(sameTarget({ kind: 'person', userId: ANA }, { kind: 'me' })).toBe(false);
    expect(
      sameTarget(
        { kind: 'group', channelId: 'g-1', name: 'A' },
        { kind: 'group', channelId: 'g-1', name: 'B' },
      ),
    ).toBe(true);
    expect(sameTarget(null, null)).toBe(true);
  });
});

describe('taskRoute + taskChannelId: person / Me / group', () => {
  const roster = [
    { channelId: 'dm-ana', channelType: 'dm', peerUserId: ANA },
    { channelId: 'g-1', channelType: 'group', peerUserId: null },
  ] as ChannelSummary[];
  const ctx = { me: ME, workspaceId: WS, roster };

  it('a person with a DM on the device: that DM, no network', async () => {
    const route = taskRoute({ kind: 'person', userId: ANA }, ctx);
    expect(route).toEqual({ kind: 'open', channelId: 'dm-ana' });
    const ensureDm = vi.fn(async () => 'never');
    const ensureNotes = vi.fn(async () => 'never');
    expect(await taskChannelId(route, { ensureDm, ensureNotes })).toBe('dm-ana');
    expect(ensureDm).not.toHaveBeenCalled();
  });

  it('a person without a DM on the device: the DM is ensured (the Message path)', async () => {
    const route = taskRoute({ kind: 'person', userId: 'u-zed' }, ctx);
    expect(route).toEqual({ kind: 'dm', userId: 'u-zed' });
    const ensureDm = vi.fn(async (id: string) => `dm-${id}`);
    expect(await taskChannelId(route, { ensureDm, ensureNotes: async () => null })).toBe(
      'dm-u-zed',
    );
    expect(ensureDm).toHaveBeenCalledWith('u-zed');
  });

  it('Me: my Personal notes, ensured first', async () => {
    const route = taskRoute({ kind: 'me' }, ctx);
    expect(route).toEqual({ kind: 'notes', channelId: 'notes__ws-1__u-me' });
    const ensureNotes = vi.fn(async () => 'notes__ws-1__u-me');
    expect(await taskChannelId(route, { ensureDm: async () => null, ensureNotes })).toBe(
      'notes__ws-1__u-me',
    );
    expect(ensureNotes).toHaveBeenCalledTimes(1);
  });

  it('picking myself as a person is Me (notes)', () => {
    expect(taskRoute({ kind: 'person', userId: ME }, ctx).kind).toBe('notes');
  });

  it('a group: its chat', async () => {
    const route = taskRoute({ kind: 'group', channelId: 'g-1', name: 'Design' }, ctx);
    expect(route).toEqual({ kind: 'open', channelId: 'g-1' });
  });

  it('no workspace or session: nowhere; a failed ensure: null', async () => {
    expect(taskRoute({ kind: 'me' }, { ...ctx, me: null }).kind).toBe('none');
    expect(taskRoute({ kind: 'person', userId: ANA }, { ...ctx, workspaceId: null }).kind).toBe(
      'none',
    );
    const thrown = await taskChannelId(
      { kind: 'dm', userId: ANA },
      {
        ensureDm: async () => {
          throw new Error('offline');
        },
        ensureNotes: async () => null,
      },
    );
    expect(thrown).toBeNull();
  });

  it('the landed link paints who it went to', () => {
    expect(localTaskLink({ kind: 'person', userId: ANA }, ME, 'dm-ana', 't-1')).toEqual({
      task_id: 't-1',
      channel_id: 'dm-ana',
      assignee_user_id: ANA,
      group_name: null,
    });
    expect(localTaskLink({ kind: 'me' }, ME, 'n', 't').assignee_user_id).toBe(ME);
    expect(
      localTaskLink({ kind: 'group', channelId: 'g-1', name: 'Design' }, ME, 'g-1', 't'),
    ).toEqual({
      task_id: 't',
      channel_id: 'g-1',
      assignee_user_id: null,
      group_name: 'Design',
    });
  });
});

describe('createCommentTask (comment_task_create)', () => {
  function client(answer: { data: unknown; error: { message: string } | null }) {
    const rpc = vi.fn(async () => answer);
    return { rpc, client: { rpc } as unknown as Parameters<typeof createCommentTask>[0]['client'] };
  }

  it('sends the explicit trace and every field; returns the task id', async () => {
    const { rpc, client: c } = client({ data: { task_id: 't-9', batch_id: 'b-1' }, error: null });
    const result = await createCommentTask({
      client: c,
      commentId: 'c-1',
      channelId: 'dm-ana',
      title: '  Fix the hook  ',
      priority: 1,
      dueOn: null,
      traceId: 'trace-1',
    });
    expect(result).toEqual({ ok: true, taskId: 't-9' });
    expect(rpc).toHaveBeenCalledWith('comment_task_create', {
      p_comment_id: 'c-1',
      p_channel_id: 'dm-ana',
      p_title: 'Fix the hook',
      p_priority: 1,
      p_due_on: null,
      p_trace_id: 'trace-1',
    });
  });

  it('task_exists comes back as exists', async () => {
    const { client: c } = client({ data: null, error: { message: 'task_exists' } });
    const result = await createCommentTask({
      client: c,
      commentId: 'c-1',
      channelId: 'g-1',
      title: 'x',
      priority: 0,
      dueOn: '2026-11-12',
      traceId: 't',
    });
    expect(result).toEqual({ ok: false, exists: true, message: 'task_exists' });
  });

  it('another refusal is a plain failure with the error copy', async () => {
    const { client: c } = client({ data: null, error: { message: 'not allowed' } });
    const result = await createCommentTask({
      client: c,
      commentId: 'c-1',
      channelId: 'g-1',
      title: 'x',
      priority: 2,
      dueOn: null,
      traceId: 't',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.exists).toBe(false);
    expect(addTaskFailed('not allowed')).toMatch(/^Couldn't add the task\. /);
  });

  it('parses only a task id', () => {
    expect(parseTaskCreate({ task_id: 't-1' })).toBe('t-1');
    expect(parseTaskCreate(null)).toBeNull();
    expect(parseTaskCreate([])).toBeNull();
    expect(parseTaskCreate({ task_id: '' })).toBeNull();
  });
});
