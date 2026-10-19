// The chat Tasks in the harness: the procs (chat_task_create, chat_task_create_many, chat_task_set,
// chat_task_save, chat_task_delete) over the chat_tasks / chat_task_events fixture tables, and a
// seed with a few items, their change lines and a missed-due bell row. The
// procs mirror the SQL (next number per chat, an event per change, the due
// setter stamped); RLS and the inbox fan-out are not emulated beyond what the
// seed writes.

import type { Row, Tables } from './postgrest';
import { GROUP_CHANNEL, ME, COLLEAGUE_A, WORKSPACE_ID, type ChatWorld } from './chat-data';

type RpcHandler = (args: Record<string, unknown>, tables: Tables) => unknown;

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `0190e${prefix}-0000-7000-8000-${String(seq).padStart(12, '0')}`;
}

function event(
  tables: Tables,
  task: Row,
  kind: string,
  oldValue: string | null,
  newValue: string | null,
  actor: string | null,
  at: string,
): void {
  (tables.chat_task_events ??= []).push({
    id: nextId('e00'),
    task_id: task.id,
    channel_id: task.channel_id,
    workspace_id: WORKSPACE_ID,
    actor_user_id: actor,
    kind,
    old_value: oldValue,
    new_value: newValue,
    created_at: at,
  });
}

/** chat_task_create / chat_task_set as the SQL behaves (actor: the signed-in user). */
export const TASK_RPC: Record<string, RpcHandler> = {
  chat_task_create: (args, tables) => {
    const rows = (tables.chat_tasks ??= []);
    const channelId = String(args.p_channel_id);
    const number =
      rows.filter((t) => t.channel_id === channelId).length > 0
        ? Math.max(...rows.filter((t) => t.channel_id === channelId).map((t) => Number(t.number))) +
          1
        : 1;
    const now = new Date().toISOString();
    const task: Row = {
      id: nextId('t00'),
      channel_id: channelId,
      workspace_id: WORKSPACE_ID,
      number,
      title: String(args.p_title).trim(),
      note: null,
      side: args.p_side,
      status: 'todo',
      priority: typeof args.p_priority === 'number' ? args.p_priority : 2,
      due_at: null,
      due_set_by: null,
      due_set_at: null,
      due_passed_at: null,
      created_by: ME,
      created_at: now,
      updated_at: now,
    };
    rows.push(task);
    event(tables, task, 'created', null, String(task.title), ME, now);
    return task.id;
  },
  chat_task_create_many: (args, tables) => {
    // One call, one 'created' event per task (the fixture's chat_task_create per item).
    const items = Array.isArray(args.p_tasks) ? (args.p_tasks as Record<string, unknown>[]) : [];
    return items.map((item) =>
      TASK_RPC.chat_task_create?.(
        {
          p_channel_id: args.p_channel_id,
          p_title: item.title,
          p_side: item.side,
          p_priority: item.priority,
        },
        tables,
      ),
    );
  },
  chat_task_set: (args, tables) => {
    const task = (tables.chat_tasks ?? []).find((t) => t.id === args.p_task_id);
    if (task === undefined) return null;
    const field = String(args.p_field);
    const value = String(args.p_value ?? '');
    const now = new Date().toISOString();
    const column = field === 'due' ? 'due_at' : field;
    const before =
      task[column] === null || task[column] === undefined ? null : String(task[column]);
    const after = field === 'due' || field === 'note' ? (value === '' ? null : value) : value;
    if (before === after) return null;
    task[column] = field === 'priority' ? Number(value) : after;
    task.updated_at = now;
    if (field === 'due') {
      task.due_set_by = ME;
      task.due_set_at = now;
      task.due_passed_at = null;
    }
    event(tables, task, field, before, after, ME, now);
    return null;
  },
  chat_task_save: (args, tables) => {
    const task = (tables.chat_tasks ?? []).find((t) => t.id === args.p_task_id);
    if (task === undefined || task.deleted_at != null) return null;
    const changes = (args.p_changes ?? {}) as Record<string, unknown>;
    const now = new Date().toISOString();
    const oldValue: Record<string, unknown> = {};
    const newValue: Record<string, unknown> = {};
    for (const [field, raw] of Object.entries(changes)) {
      const column = field === 'due' ? 'due_at' : field;
      const after =
        field === 'priority'
          ? Number(raw)
          : field === 'due' || field === 'note'
            ? raw === '' || raw == null
              ? null
              : String(raw)
            : String(raw);
      const before = task[column] ?? null;
      if (String(before) === String(after)) continue;
      oldValue[field] = before;
      newValue[field] = after;
      task[column] = after;
      if (field === 'due') {
        task.due_set_by = ME;
        task.due_set_at = now;
        task.due_passed_at = null;
      }
    }
    if (Object.keys(newValue).length === 0) return null;
    task.updated_at = now;
    event(tables, task, 'edited', JSON.stringify(oldValue), JSON.stringify(newValue), ME, now);
    return null;
  },
  chat_task_delete: (args, tables) => {
    const task = (tables.chat_tasks ?? []).find((t) => t.id === args.p_task_id);
    if (task === undefined || task.deleted_at != null) return null;
    const now = new Date().toISOString();
    task.deleted_at = now;
    task.deleted_by = ME;
    task.updated_at = now;
    event(tables, task, 'deleted', null, null, ME, now);
    return null;
  },
};

export const TASK_CHANNEL = GROUP_CHANNEL;
export const TASK_DUE_ID = '0190e100-0000-7000-8000-000000000003';
export const TASK_DUE_TITLE = 'Caption for the reel';
export const TASK_ROW_TITLE = 'Hook options';

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Seed the group chat's list: items 8 to 11 (agency and client, P0 to P2, a
 * due today, a missed one), each with its created line after the newest
 * message, and an unread task_due bell row for the missed item.
 */
export function seedTasks(world: ChatWorld, now: number = Date.now()): void {
  const tables = world.tables;
  const last = world.groupMessages[world.groupMessages.length - 1];
  const base = Date.parse(String(last?.created_at ?? iso(now - 3_600_000))) + 60_000;
  const make = (over: Row): Row => ({
    channel_id: TASK_CHANNEL,
    workspace_id: WORKSPACE_ID,
    note: null,
    status: 'todo',
    priority: 2,
    due_at: null,
    due_set_by: null,
    due_set_at: null,
    due_passed_at: null,
    created_by: COLLEAGUE_A,
    created_at: iso(base),
    updated_at: iso(base),
    ...over,
  });
  const tasks: Row[] = [
    make({
      id: '0190e100-0000-7000-8000-000000000001',
      number: 8,
      title: TASK_ROW_TITLE,
      side: 'agency',
      priority: 1,
    }),
    make({
      id: '0190e100-0000-7000-8000-000000000002',
      number: 9,
      title: 'Shot list',
      side: 'agency',
      priority: 2,
      due_at: iso(now + 2 * 3_600_000),
      due_set_by: COLLEAGUE_A,
      due_set_at: iso(base),
    }),
    make({
      id: TASK_DUE_ID,
      number: 10,
      title: TASK_DUE_TITLE,
      side: 'client',
      priority: 0,
      due_at: iso(now - 3_600_000),
      due_set_by: COLLEAGUE_A,
      due_set_at: iso(base),
      due_passed_at: iso(now - 3_540_000),
    }),
    make({
      id: '0190e100-0000-7000-8000-000000000004',
      number: 11,
      title: 'Brand colours',
      side: 'client',
      priority: 2,
    }),
  ];
  tables.chat_tasks = tasks;
  tables.chat_task_events = [];
  tasks.forEach((task, k) => {
    event(tables, task, 'created', null, String(task.title), COLLEAGUE_A, iso(base + k * 1000));
  });
  const due = tasks[2];
  if (due !== undefined) {
    (tables.inbox_entries ??= []).push({
      id: '0190f100-0000-7000-8000-0000000000e1',
      user_id: ME,
      actor_user_id: null,
      workspace_id: WORKSPACE_ID,
      event_type: 'task_due',
      entity_type: 'chat_channel',
      entity_id: TASK_CHANNEL,
      scope: 'groups',
      scope_key: TASK_CHANNEL,
      tier: 'urgent',
      payload: {
        task_id: due.id,
        number: due.number,
        title: due.title,
        kind: 'due_passed',
        old: due.due_at,
        new: null,
      },
      read_at: null,
      snoozed_until: null,
      email_sent_at: null,
      deleted_at: null,
      created_at: iso(now - 3_540_000),
    });
  }
}

export const DUE_SOON_ID = '0190e100-0000-7000-8000-000000000012';
export const DUE_SOON_TITLE = 'Reel cover';

/** One more open Agency item (12) in the group chat, due at `dueMs` (after seedTasks). */
export function seedDueSoon(world: ChatWorld, dueMs: number): void {
  const at = iso(dueMs - 3_600_000);
  (world.tables.chat_tasks ??= []).push({
    id: DUE_SOON_ID,
    channel_id: TASK_CHANNEL,
    workspace_id: WORKSPACE_ID,
    number: 12,
    title: DUE_SOON_TITLE,
    note: null,
    side: 'agency',
    status: 'todo',
    priority: 1,
    due_at: iso(dueMs),
    due_set_by: ME,
    due_set_at: at,
    due_passed_at: null,
    created_by: ME,
    created_at: at,
    updated_at: at,
  });
}

export const OLDER_LINE_TITLE = 'Moodboard refs';

/**
 * Older history for the group chat: 30 messages before the seeded ones (so a
 * second page exists), a burst of 205 changes right after the newest message
 * (the first events read comes back full) and 3 changes inside the older page
 * (the oldest 20 rows; the first page of 50 ends at "Older note 21"),
 * which only the older-page read brings.
 */
export function seedOlderTaskHistory(world: ChatWorld): void {
  const tables = world.tables;
  const first = world.groupMessages[0];
  const last = world.groupMessages[world.groupMessages.length - 1];
  const firstMs = Date.parse(String(first?.created_at));
  const older: Row[] = Array.from({ length: 30 }, (_, k) => {
    const n = 30 - k;
    return {
      ...first,
      id: `0190e300-0000-7000-8000-${String(k + 1).padStart(12, '0')}`,
      sender_user_id: k % 2 === 0 ? COLLEAGUE_A : ME,
      body: `Older note ${k + 1}`,
      attachment_asset_ids: null,
      attachment_meta: null,
      shared_post_ids: null,
      created_at: iso(firstMs - n * 40 * 60_000),
    };
  });
  (tables.chat_messages ??= []).push(...older);
  const task = make8(tables);
  const lastMs = Date.parse(String(last?.created_at)) + 120_000;
  for (let k = 0; k < 205; k += 1) {
    event(tables, task, 'note', null, `n${k}`, COLLEAGUE_A, iso(lastMs + k * 200));
  }
  const olderTask: Row = {
    ...task,
    id: '0190e100-0000-7000-8000-000000000009',
    number: 7,
    title: OLDER_LINE_TITLE,
  };
  tables.chat_tasks?.push(olderTask);
  for (const k of [2, 8, 14]) {
    const at = Date.parse(String(older[k]?.created_at)) + 60_000;
    event(tables, olderTask, 'priority', '2', '1', ME, iso(at));
  }
}

function make8(tables: Tables): Row {
  const task = (tables.chat_tasks ?? []).find((t) => t.number === 8);
  if (task === undefined) throw new Error('seedTasks first');
  return task;
}
