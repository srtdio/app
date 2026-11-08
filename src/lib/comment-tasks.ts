// Comment to task: the pure rules behind a comment's action bar, its task tag
// and the To-do sheet's target, plus the one write (comment_task_create).
//
//   * The bar (left to right): Reply, Resolve, To-do, Edit, | Delete. Edit and
//     the divider + Delete only on the viewer's own comment; Resolve only where
//     resolving is allowed today; To-do only for agency roles and only while
//     the comment has no task.
//   * The tag under the body: agency "Task · {first name}" / "Task · {group}" /
//     "Task · You" ("Task done · ..." in the good token once done); a client
//     "Task assigned" / "Task done", never a name. Finishing a task never
//     resolves the comment.
//   * The target chat: a person -> my DM with them, Me -> my Personal notes, a
//     group -> its chat. Decided here without the network; the caller ensures
//     the DM / notes row only when it is not on the device.
//
// The task link (comment_tasks) rides in the same comments read; RLS returns
// it to agency roles only, so a client never holds a name or a chat id.

import type { Client } from '@srtdio/rpc';
import type { Database } from '@srtdio/schemas';
import { stripFormat, type CommentTaskEmbed } from '@srtdio/comments';
import type { ChannelSummary } from '@/lib/chat-reads';
import { notesChannelId } from '@/lib/chat/notes';
import { TASK_TITLE_MAX, type TaskPriority } from '@/lib/chat/tasks';
import { errorText } from '@/lib/error-copy';
import { chatTaskHref } from '@/lib/inbox/bell-types';
import { personDmRoute, personFirstName } from '@/lib/person-card';
import type { MentionCandidate } from '@/lib/workspace-members';

type Functions = Database['public']['Functions'];

/** The workspace roles that may turn a comment into a task (the proc's own check). */
export const TASK_ROLES: readonly string[] = ['owner', 'admin', 'agency'];

/** Whether a workspace role is agency side (owner, admin, agency). Pure. */
export function isAgencyRole(role: string | null | undefined): boolean {
  return typeof role === 'string' && TASK_ROLES.includes(role);
}

/** A comment's task state as the row carries it. */
export type CommentTaskState = 'assigned' | 'done';

/** comments.task_state read safely ('assigned' | 'done', anything else none). Pure. */
export function taskStateOf(value: string | null | undefined): CommentTaskState | null {
  return value === 'assigned' || value === 'done' ? value : null;
}

// ---------------------------------------------------------------------------
// The action bar
// ---------------------------------------------------------------------------

/**
 * The bar's Resolve slot: Resolve (open), Reopen (a resolved plain thread, the
 * agency's), Confirm (a client's resolved checkpoint awaiting them), or none.
 */
export type ResolveSlot = 'resolve' | 'reopen' | 'confirm' | null;

/** What the Resolve slot shows for a row, exactly where resolving is allowed today. Pure. */
export function resolveSlot(input: {
  /** A reply never resolves (the thread does, on its root). */
  reply: boolean;
  /** A checkpoint (ledger_seq set) or a plain thread. */
  point: boolean;
  isClient: boolean;
  resolved: boolean;
  /** A checkpoint the approver confirmed. */
  confirmed: boolean;
}): ResolveSlot {
  if (input.reply) return null;
  if (input.point) {
    if (input.isClient) return input.resolved && !input.confirmed ? 'confirm' : null;
    return input.resolved ? null : 'resolve';
  }
  if (input.isClient) return null;
  return input.resolved ? 'reopen' : 'resolve';
}

export interface CommentBarInput {
  /** The row can be replied to (a live comment; false while editing). */
  canReply: boolean;
  resolve: ResolveSlot;
  /** The viewer is agency side (owner, admin, agency). */
  viewerIsAgency: boolean;
  /** comments.task_state is set (a task already exists). */
  hasTask: boolean;
  /** Author-only Edit (a frozen checkpoint withholds it). */
  canEdit: boolean;
  /** Author-only Delete (a frozen checkpoint withholds it). */
  canDelete: boolean;
}

/** The buttons a comment's bar shows, in order. */
export interface CommentBar {
  reply: boolean;
  resolve: ResolveSlot;
  todo: boolean;
  edit: boolean;
  /** The hairline divider and Delete, together. */
  delete: boolean;
}

/** Which bar buttons a comment shows. Hide what a person can't do. Pure. */
export function commentBar(input: CommentBarInput): CommentBar {
  return {
    reply: input.canReply,
    resolve: input.resolve,
    todo: input.viewerIsAgency && !input.hasTask,
    edit: input.canEdit,
    delete: input.canDelete,
  };
}

/** Whether a bar shows anything at all. Pure. */
export function barHasButtons(bar: CommentBar): boolean {
  return bar.reply || bar.resolve !== null || bar.todo || bar.edit || bar.delete;
}

// ---------------------------------------------------------------------------
// The tag under the body
// ---------------------------------------------------------------------------

export const TASK_ASSIGNED = 'Task assigned';
export const TASK_DONE = 'Task done';
const TASK_WORD = 'Task';
const YOU = 'You';

export interface TaskTag {
  text: string;
  tone: 'neutral' | 'good';
  /** Agency only: the chat's Tasks sheet on this task; null when there is none to open. */
  href: string | null;
}

/** The one grey tag under a comment with a task, per role and state. Pure. */
export function commentTaskTag(input: {
  state: string | null | undefined;
  link: CommentTaskEmbed | null | undefined;
  viewerIsAgency: boolean;
  me: string | null;
  /** A member's display name from what the device holds; null when unknown. */
  nameOf: (userId: string) => string | null;
}): TaskTag | null {
  const state = taskStateOf(input.state);
  if (state === null) return null;
  const done = state === 'done';
  const tone = done ? 'good' : 'neutral';
  const plain = done ? TASK_DONE : TASK_ASSIGNED;
  const link = input.link ?? null;
  if (!input.viewerIsAgency || link === null) return { text: plain, tone, href: null };
  const href = chatTaskHref(link.channel_id, link.task_id);
  const who = taskAssigneeLabel(link, input.me, input.nameOf);
  if (who === null) return { text: plain, tone, href };
  return { text: `${done ? TASK_DONE : TASK_WORD} · ${who}`, tone, href };
}

/** "You", the assignee's first name, or the group's name; null when none is known. Pure. */
export function taskAssigneeLabel(
  link: Pick<CommentTaskEmbed, 'assignee_user_id' | 'group_name'>,
  me: string | null,
  nameOf: (userId: string) => string | null,
): string | null {
  const assignee = link.assignee_user_id;
  if (assignee !== null) {
    if (me !== null && assignee === me) return YOU;
    const name = nameOf(assignee);
    const first = name === null ? '' : personFirstName(name);
    return first !== '' ? first : null;
  }
  const group = link.group_name?.trim() ?? '';
  return group !== '' ? group : null;
}

// ---------------------------------------------------------------------------
// The To-do sheet
// ---------------------------------------------------------------------------

export const NEW_TASK_TITLE = 'New task';
export const ADD_LABEL = 'Add';
export const ME_LABEL = 'Me';
export const PEOPLE_LABEL = 'People';
export const GROUPS_LABEL = 'Groups';
export const TASK_FIELD_LABEL = 'Task';
export const ADD_DATE_LABEL = 'Add date';
export const SEARCH_PEOPLE_LABEL = 'Search people';
/** How many people show as chips before the search. */
export const PEOPLE_CHIPS_MAX = 6;

/** The task's title from a comment's plain text: no format marks, one line, at most 200. Pure. */
export function taskTitleFrom(text: string): string {
  return stripFormat(text).replace(/\s+/g, ' ').trim().slice(0, TASK_TITLE_MAX);
}

/** One person chip: agency side only, never a client. */
export interface TaskPerson {
  id: string;
  name: string;
  firstName: string;
}

/** Agency-side members other than me (Me is its own chip), by name. Pure. */
export function taskPeople(candidates: readonly MentionCandidate[], me: string | null): TaskPerson[] {
  const out: TaskPerson[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (c.id === me || seen.has(c.id) || !isAgencyRole(c.role) || c.name.trim() === '') continue;
    seen.add(c.id);
    out.push({ id: c.id, name: c.name, firstName: personFirstName(c.name) || c.name });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** One group chip: a group chat the viewer belongs to. */
export interface TaskGroup {
  channelId: string;
  name: string;
}

/** The viewer's group chats from the device's chat list, by name. Pure. */
export function taskGroups(roster: readonly ChannelSummary[]): TaskGroup[] {
  return roster
    .filter((c) => c.channelType === 'group' && c.title.trim() !== '')
    .map((c) => ({ channelId: c.channelId, name: c.title }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Who the task goes to: one pick. */
export type TaskTarget =
  | { kind: 'person'; userId: string }
  | { kind: 'me' }
  | { kind: 'group'; channelId: string; name: string };

/** Whether two targets are the same pick. Pure. */
export function sameTarget(a: TaskTarget | null, b: TaskTarget | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === 'me' || b.kind === 'me') return a.kind === b.kind;
  if (a.kind === 'person' && b.kind === 'person') return a.userId === b.userId;
  if (a.kind === 'group' && b.kind === 'group') return a.channelId === b.channelId;
  return false;
}

/**
 * Where a target's task lands, decided without the network: an open chat
 * (cached DM, a group), my notes (ensured first, as Chat home does), a DM to
 * ensure (dm_channel_ensure, the person card's Message path), or nowhere. Pure.
 */
export type TaskRoute =
  | { kind: 'open'; channelId: string }
  | { kind: 'notes'; channelId: string }
  | { kind: 'dm'; userId: string }
  | { kind: 'none' };

export function taskRoute(
  target: TaskTarget,
  ctx: {
    me: string | null;
    workspaceId: string | null;
    roster: readonly Pick<ChannelSummary, 'channelId' | 'channelType' | 'peerUserId'>[];
  },
): TaskRoute {
  if (target.kind === 'group') return { kind: 'open', channelId: target.channelId };
  const userId = target.kind === 'me' ? ctx.me : target.userId;
  if (userId === null || ctx.workspaceId === null || ctx.workspaceId === '') return { kind: 'none' };
  if (userId === ctx.me) {
    return { kind: 'notes', channelId: notesChannelId(ctx.workspaceId, userId) };
  }
  const route = personDmRoute({ userId, me: ctx.me, workspaceId: ctx.workspaceId, roster: ctx.roster });
  if (route.kind === 'open') return { kind: 'open', channelId: route.channelId };
  if (route.kind === 'ensure') return { kind: 'dm', userId };
  return { kind: 'none' };
}

/** The chat id a route lands on, ensuring the DM or notes row when needed. Never throws. */
export async function taskChannelId(
  route: TaskRoute,
  deps: {
    ensureDm: (userId: string) => Promise<string | null>;
    ensureNotes: () => Promise<string | null>;
  },
): Promise<string | null> {
  try {
    if (route.kind === 'open') return route.channelId;
    if (route.kind === 'notes') return (await deps.ensureNotes()) ?? null;
    if (route.kind === 'dm') return await deps.ensureDm(route.userId);
    return null;
  } catch {
    return null;
  }
}

/** The link a landed task paints at once (the read then reconciles). Pure. */
export function localTaskLink(
  target: TaskTarget,
  me: string | null,
  channelId: string,
  taskId: string,
): CommentTaskEmbed {
  return {
    task_id: taskId,
    channel_id: channelId,
    assignee_user_id: target.kind === 'person' ? target.userId : target.kind === 'me' ? me : null,
    group_name: target.kind === 'group' ? target.name : null,
  };
}

// ---------------------------------------------------------------------------
// The write
// ---------------------------------------------------------------------------

/** "Couldn't add the task. {reason}". */
export function addTaskFailed(error: unknown): string {
  return errorText('add the task', error);
}

export type CreateCommentTaskResult =
  | { ok: true; taskId: string }
  | { ok: false; exists: boolean; message: string };

/** comment_task_create's answer ({task_id, batch_id}) to its task id; null when not that shape. Pure. */
export function parseTaskCreate(data: unknown): string | null {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  const id = (data as Record<string, unknown>).task_id;
  return typeof id === 'string' && id !== '' ? id : null;
}

/**
 * One comment_task_create: the task in the target chat (one chat_task_save_batch
 * on the server, so the chat line and alert fire as for any new task) and the
 * comment's link. p_trace_id is the proc's explicit trace. 'task_exists' comes
 * back as exists (the caller refreshes the comment). Never throws.
 */
export async function createCommentTask(params: {
  client: Client;
  commentId: string;
  channelId: string;
  title: string;
  priority: TaskPriority;
  dueOn: string | null;
  traceId: string;
}): Promise<CreateCommentTaskResult> {
  const args: Functions['comment_task_create']['Args'] = {
    p_comment_id: params.commentId,
    p_channel_id: params.channelId,
    p_title: params.title.trim().slice(0, TASK_TITLE_MAX),
    p_priority: params.priority,
    // The generated arg type is non-nullable, but the proc takes NULL for no date.
    p_due_on: params.dueOn as unknown as string,
    p_trace_id: params.traceId,
  };
  try {
    const { data, error } = await params.client.rpc('comment_task_create', args);
    if (error) {
      return { ok: false, exists: /task_exists/.test(error.message), message: error.message };
    }
    const taskId = parseTaskCreate(data);
    return taskId !== null
      ? { ok: true, taskId }
      : { ok: false, exists: false, message: 'comment_task_create returned no task' };
  } catch (error) {
    return { ok: false, exists: false, message: String(error) };
  }
}
