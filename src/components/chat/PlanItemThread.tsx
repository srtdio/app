// A plan item's comments as a chat thread, with Sorted chat's look: others on
// the left under their avatar, the viewer's own on the right in bubble-own.
// Consecutive comments from one author within PLAN_RUN_GAP_MS are one run: the
// name and role sit over its first bubble, the time under its last. A day line
// ("Today", "Yesterday", "3 Nov", chat's dayPillLabel) goes between days.
// Creators-only comments are warn-soft with the warn line and a lock label.
// Mention tokens render as pills (names from the shared registry, never a raw
// token). Also the @ helpers the comment box uses: who can be tagged (never me;
// agency side only on a creators-only note or a plan not shared with the
// client), and which tagged people a creators-only note blocks.
//
// Pure helpers carry the logic; the components only draw. No reads: author
// roles and photos come from the members this session already holds
// (peekWorkspaceMembers), never a request on paint. Tokens only.

import { Fragment, useEffect, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { PersonTrigger } from '@/components/ui/PersonTrigger';
import { ICON_SIZE, IconLock } from '@/components/ui/icons';
import { dayPillLabel } from '@/components/chat/day-separators';
import {
  BUBBLE_PAD,
  BUBBLE_SHAPE,
  DATE_PILL_TYPE,
  sized,
  useChatLayout,
} from '@/components/chat/chat-type';
import { renderMessageBody } from '@/components/chat/message-body';
import { TEAM_ONLY_LABEL } from '@/components/chat/plan-card';
import { roleLabel } from '@/components/pages/settings/members-data';
import { startChatMembers } from '@/lib/chat/open-members';
import {
  ALL_MENTION,
  filterMentionMembers,
  mentionIds,
  personAvatar,
  personMentionLabel,
  rememberMentionNames,
  splitMentions,
  type MentionMember,
} from '@/lib/chat/mentions';
import type { CommentVisibility, PlanAudience } from '@/lib/chat/plans';
import { cn } from '@/lib/cn';
import { civilDay, formatTime } from '@/lib/time';
import { isFormerMember, resolvePersonMentionText } from '@/lib/chat/mentions';
import { canReplyPrivately, planCommentPrivateReplyDraft } from '@/lib/reply-privately';
import type { PrivateReplyDraft } from '@/lib/chat/private-reply';
import { ReplyPrivatelyButton } from '@/components/comments/ReplyPrivatelyButton';
import { supabase } from '@/lib/supabase';
import { peekWorkspaceMembers, type WorkspaceMembersData } from '@/lib/workspace-members';

/** A comment shown in the thread: a recorded row, or a pending own one. */
export interface ShownComment {
  id: string;
  authorUserId: string | null;
  authorName: string;
  /** The viewer wrote it (a pending one always). */
  mine: boolean;
  body: string;
  visibility: CommentVisibility;
  createdAt: string;
  pending: boolean;
  /** authorName is the author's real name (their name read answered), not a fallback. */
  authorKnown?: boolean;
}

/** Where a plan comment's Reply privately points: the plan, the item, its title. */
export interface PlanReplyPrivatelyTarget {
  planId: string;
  itemId: string;
  /** The plan item title the screen shows. */
  whereLabel: string;
}

/**
 * Whether a plan comment offers Reply privately: a recorded comment by someone
 * else whose name is known and who is still a member (`former` when the held
 * members or the name registry say they left). Pure.
 */
export function showPlanReplyPrivately(
  comment: Pick<ShownComment, 'authorUserId' | 'authorName' | 'mine' | 'pending' | 'authorKnown'>,
  me: string | null,
  former: boolean,
): boolean {
  if (comment.mine || comment.pending || comment.authorKnown !== true) return false;
  return canReplyPrivately({
    authorUserId: comment.authorUserId,
    me,
    authorName: comment.authorName,
    former,
  });
}

/** Whether the held members (when held) or the name registry say this person left. */
function authorLeft(
  held: WorkspaceMembersData | null,
  workspaceId: string | null,
  userId: string | null,
): boolean {
  if (userId === null) return false;
  if (isFormerMember(workspaceId, userId)) return true;
  if (held === null) return false;
  return !held.rows.some((r) => r.user_id === userId && r.active === true && r.removed_at === null);
}

/** Comments this close together from one author are one run. */
export const PLAN_RUN_GAP_MS = 5 * 60 * 1000;

/** The roles on the agency side (Creators); everyone else is an approver. */
const AGENCY_ROLES = new Set(['owner', 'admin', 'agency']);

/** The one line when an approver cannot be tagged (picker, box, server refusal toast). */
export const MENTION_TEAM_NOTE =
  "Approvers can't see creators-only notes, so they can't be tagged here.";

/** The client's line under the box (no chip). */
export const CLIENT_VISIBILITY_LINE = 'Everyone in this plan can see';

/** The agency chip's labels. */
export const EVERYONE_CHIP_LABEL = 'Everyone can see';
export const TEAM_CHIP_LABEL = TEAM_ONLY_LABEL;

/** One thread row: a day line or a comment with its place in its run. */
export type PlanThreadRow =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'comment'; comment: ShownComment; head: boolean; tail: boolean };

function timeOf(c: Pick<ShownComment, 'createdAt'>): number {
  const t = Date.parse(c.createdAt);
  return Number.isFinite(t) ? t : 0;
}

/** Whether `next` starts a new run after `prev`: another author, or a 5 min gap. Pure. */
export function breaksPlanRun(
  prev: Pick<ShownComment, 'authorUserId' | 'mine' | 'createdAt'> | undefined,
  next: Pick<ShownComment, 'authorUserId' | 'mine' | 'createdAt'>,
): boolean {
  if (prev === undefined) return true;
  if (prev.mine !== next.mine) return true;
  if (!prev.mine && prev.authorUserId !== next.authorUserId) return true;
  const a = timeOf(prev);
  const b = timeOf(next);
  if (a === 0 || b === 0) return false;
  return b - a >= PLAN_RUN_GAP_MS;
}

/**
 * The thread's rows in order: a day line before the first comment and before
 * every comment on a new calendar day (device zone), then each comment with
 * head (first of its run) and tail (last of its run). A day line ends a run.
 * `timeZone` is for tests. Pure.
 */
export function planThreadRows(
  comments: readonly ShownComment[],
  nowMs: number,
  timeZone?: string,
): PlanThreadRow[] {
  const days = comments.map((c) => (timeOf(c) > 0 ? civilDay(timeOf(c), timeZone) : null));
  const rows: PlanThreadRow[] = [];
  let current: string | null = null;
  comments.forEach((comment, i) => {
    const day = days[i] ?? null;
    const newDay = day !== null && day !== current;
    if (newDay) {
      current = day;
      rows.push({ kind: 'day', key: `day-${day}`, label: dayPillLabel(day, nowMs, timeZone) });
    }
    const next = comments[i + 1];
    const nextDay = days[i + 1] ?? null;
    const nextNewDay = next !== undefined && nextDay !== null && nextDay !== current;
    rows.push({
      kind: 'comment',
      comment,
      head: newDay || breaksPlanRun(comments[i - 1], comment),
      tail: next === undefined || nextNewDay || breaksPlanRun(comment, next),
    });
  });
  return rows;
}

/** The picker's people from a members read: active members with a profile. Pure. */
export function planMentionMembers(
  data: Pick<WorkspaceMembersData, 'rows' | 'profiles'>,
): MentionMember[] {
  const seen = new Set<string>();
  const out: MentionMember[] = [];
  for (const row of data.rows) {
    if (row.active !== true || row.removed_at !== null || seen.has(row.user_id)) continue;
    seen.add(row.user_id);
    const profile = data.profiles.get(row.user_id);
    out.push({
      userId: row.user_id,
      displayName: profile?.displayName ?? 'Member',
      avatarUrl: profile?.avatarUrl ?? null,
      username: profile?.username ?? null,
      role: row.role,
    });
  }
  return out;
}

/** Whether a person is on the agency side (Creators). Pure. */
export function isAgencySide(member: Pick<MentionMember, 'role'>): boolean {
  return member.role !== null && AGENCY_ROLES.has(member.role);
}

/**
 * Whether only the agency side can be tagged: a creators-only note, or a plan
 * not shared with the client (approvers cannot see either). Pure.
 */
export function mentionsRestricted(visibility: CommentVisibility, audience: PlanAudience): boolean {
  return visibility === 'team' || audience === 'team';
}

/** The people the picker offers: never me; agency side only when restricted. Pure. */
export function taggableMembers(
  members: readonly MentionMember[],
  selfId: string | null,
  restricted: boolean,
): MentionMember[] {
  return members.filter((m) => m.userId !== selfId && (!restricted || isAgencySide(m)));
}

/**
 * The picker rows for a query (filterMentionMembers' order) and whether an
 * approver matching the query was left out (the note line shows then). Pure.
 */
export function planPickerRows(
  members: readonly MentionMember[],
  query: string,
  selfId: string | null,
  restricted: boolean,
): { rows: MentionMember[]; hiddenApprovers: boolean } {
  const all = filterMentionMembers(members, query, selfId);
  const rows = restricted ? all.filter(isAgencySide) : all;
  return { rows, hiddenApprovers: rows.length < all.length };
}

/**
 * The tagged people a restricted note cannot carry: every token in the body
 * whose member is an approver. Unknown people are left to the server. Pure.
 */
export function blockedMentions(
  body: string,
  members: readonly MentionMember[] | null,
  restricted: boolean,
): string[] {
  if (!restricted || members === null) return [];
  const byId = new Map(members.map((m) => [m.userId.toLowerCase(), m]));
  return mentionIds(body).filter((id) => {
    const m = byId.get(id.toLowerCase());
    return m !== undefined && !isAgencySide(m);
  });
}

/**
 * Which keys the open @ picker takes (chat's composer rule): Up / Down move,
 * Enter or Tab picks (Enter never sends while it is open), Escape closes. Null
 * for any other key and during IME composition. Pure.
 */
export function mentionKeyAction(
  key: string,
  isComposing: boolean,
): 'up' | 'down' | 'pick' | 'close' | null {
  if (isComposing) return null;
  if (key === 'ArrowUp') return 'up';
  if (key === 'ArrowDown') return 'down';
  if (key === 'Enter' || key === 'Tab') return 'pick';
  if (key === 'Escape') return 'close';
  return null;
}

/** Whether a comment write was refused for its mentions. Pure. */
export function isInvalidMention(message: string): boolean {
  return /invalid_mention/.test(message);
}

/**
 * The workspace's people for the @ picker. Nothing loads on paint: `load` (the
 * box's focus, or the first "@") answers from the held members, else joins the
 * one shared members read (startChatMembers). Never throws.
 */
export function usePlanMentionMembers(
  me: string | null,
  workspaceId: string | null,
): { members: MentionMember[] | null; load: () => void } {
  const [members, setMembers] = useState<MentionMember[] | null>(null);
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    setMembers(null);
    setAsked(false);
  }, [me, workspaceId]);
  useEffect(() => {
    if (!asked || members !== null || me === null || workspaceId === null) return;
    const held = peekWorkspaceMembers(me, workspaceId);
    if (held !== null) {
      const list = planMentionMembers(held);
      rememberMentionNames(workspaceId, list);
      setMembers(list);
      return;
    }
    let active = true;
    void startChatMembers(supabase, me, workspaceId).then((data) => {
      if (!active || data.error !== null) return;
      const list = planMentionMembers(data);
      rememberMentionNames(workspaceId, list);
      setMembers(list);
    });
    return () => {
      active = false;
    };
  }, [asked, members, me, workspaceId]);
  return { members, load: () => setAsked(true) };
}

/** A body with its mention tokens as pills; the text between keeps chat's links. */
function bodyNodes(body: string, ownTone: boolean, workspaceId: string | null): ReactNode[] {
  return splitMentions(body).map((segment, i) => {
    if (segment.kind === 'text') {
      return <Fragment key={i}>{renderMessageBody(segment.text, ownTone)}</Fragment>;
    }
    const label = personMentionLabel(workspaceId, segment.userId);
    if (label === null) return null;
    const pill = (
      <span
        data-plan-mention={segment.userId}
        className={cn(
          'whitespace-nowrap rounded-full px-1.5 font-medium lit-tint',
          ownTone ? 'bg-accent-fg/[0.22] text-accent-fg' : 'bg-accent-soft text-accent',
        )}
      >
        {label}
      </span>
    );
    // "@all" names no one; every person's pill opens the person card.
    if (segment.userId.toLowerCase() === ALL_MENTION) return <Fragment key={i}>{pill}</Fragment>;
    return (
      <PersonTrigger
        key={i}
        userId={segment.userId}
        {...(isFormerMember(workspaceId, segment.userId) ? { former: true } : {})}
      >
        {pill}
      </PersonTrigger>
    );
  });
}

/** The author's role label from the held members; null when not held. */
function authorRole(held: WorkspaceMembersData | null, userId: string | null): string | null {
  if (held === null || userId === null) return null;
  const row = held.rows.find((r) => r.user_id === userId && r.active === true);
  return row !== undefined ? roleLabel(row.role) : null;
}

/** One day line between comments (chat's day pill look). No motion. */
function PlanDayLine(props: { label: string }): ReactElement {
  const layout = useChatLayout();
  return (
    <li role="separator" aria-label={props.label} data-plan-day="" className="flex justify-center">
      <span
        className={cn(
          'mb-1.5 mt-2 self-center rounded-full border border-border bg-panel-2 px-2.5 py-0.5 text-fg-3 lit-pill',
          sized(DATE_PILL_TYPE, layout),
        )}
      >
        {props.label}
      </span>
    </li>
  );
}

/** One comment bubble with its run's name line (others) and time (the run's last). */
function PlanBubble(props: {
  row: Extract<PlanThreadRow, { kind: 'comment' }>;
  workspaceId: string | null;
  held: WorkspaceMembersData | null;
  highlighted: boolean;
  me: string | null;
  replyPrivately: PlanReplyPrivatelyTarget | null;
}): ReactElement {
  const layout = useChatLayout();
  const { comment: c, head, tail } = props.row;
  const target = props.replyPrivately;
  const authorUserId = c.authorUserId;
  const replyTo =
    target !== null &&
    authorUserId !== null &&
    showPlanReplyPrivately(c, props.me, authorLeft(props.held, props.workspaceId, authorUserId))
      ? { target, authorUserId }
      : null;
  const team = c.visibility === 'team';
  const mine = c.mine;
  // White text on bubble-own; a creators-only note keeps the warn look (ink text).
  const ownTone = mine && !team;
  const role = mine ? null : authorRole(props.held, c.authorUserId);
  const avatarSrc =
    c.authorUserId !== null
      ? (props.held?.profiles.get(c.authorUserId)?.avatarUrl ??
        personAvatar(props.workspaceId, c.authorUserId))
      : null;
  // The author's photo and name open the person card (a pending own comment
  // and an author with no id have nothing to open).
  const authorId = !mine && !c.pending ? authorUserId : null;
  // Reply privately's quote: the card's source when the author is tapped too.
  const quote =
    replyTo !== null
      ? (): PrivateReplyDraft =>
          planCommentPrivateReplyDraft({
            commentId: c.id,
            authorUserId: replyTo.authorUserId,
            authorName: c.authorName,
            excerpt: resolvePersonMentionText(c.body, props.workspaceId),
            whereLabel: replyTo.target.whereLabel,
            planId: replyTo.target.planId,
            itemId: replyTo.target.itemId,
          })
      : null;
  const asAuthor = (node: ReactElement, display: 'inline' | 'block'): ReactElement =>
    authorId !== null ? (
      <PersonTrigger
        userId={authorId}
        name={c.authorKnown === true ? c.authorName : null}
        avatarUrl={avatarSrc}
        former={authorLeft(props.held, props.workspaceId, authorId)}
        display={display}
        {...(quote !== null ? { source: quote } : {})}
      >
        {node}
      </PersonTrigger>
    ) : (
      node
    );
  return (
    <li
      data-plan-comment-id={c.id}
      data-plan-comment={c.visibility}
      data-plan-comment-side={mine ? 'own' : 'other'}
      {...(head ? { 'data-plan-run-head': '' } : {})}
      {...(tail ? { 'data-plan-run-tail': '' } : {})}
      {...(props.highlighted ? { 'data-plan-comment-highlight': '' } : {})}
      className={cn('flex gap-2', mine ? 'justify-end' : 'justify-start', head ? 'mt-2' : 'mt-0.5')}
    >
      {!mine ? (
        <span className="w-8 shrink-0">
          {head
            ? asAuthor(
                <Avatar
                  name={c.authorName}
                  role="header"
                  {...(avatarSrc !== null ? { src: avatarSrc } : {})}
                />,
                'block',
              )
            : null}
        </span>
      ) : null}
      <div
        className={cn(
          'flex min-w-0 flex-col gap-0.5',
          mine ? 'items-end' : 'items-start',
          'max-w-[80%]',
        )}
      >
        {!mine && head ? (
          <span data-plan-comment-author="" className="truncate text-base font-medium text-fg-2">
            {asAuthor(<>{c.authorName}</>, 'inline')}
            {role !== null ? ` · ${role}` : null}
          </span>
        ) : null}
        <div
          data-plan-comment-bubble=""
          className={cn(
            'flex min-w-0 flex-col gap-1',
            sized(BUBBLE_SHAPE, layout),
            sized(BUBBLE_PAD, layout),
            team
              ? // bg-none: the warn fill shows through the bubble's lit gradient.
                'border border-[color:var(--warn-line)] bg-warn-soft bg-none text-fg lit-bubble-other'
              : mine
                ? 'bg-bubble-own text-accent-fg lit-bubble-own'
                : 'bg-panel-2 text-fg lit-bubble-other',
            c.pending && 'opacity-70',
            props.highlighted && 'lit-today',
          )}
        >
          {team ? (
            <span
              data-plan-comment-team=""
              className="inline-flex items-center gap-1 text-sm text-warn"
            >
              <IconLock size={ICON_SIZE.inline} />
              {TEAM_ONLY_LABEL}
            </span>
          ) : null}
          <p
            className={cn(
              'whitespace-pre-wrap break-words text-base',
              ownTone ? 'text-accent-fg' : 'text-fg',
            )}
          >
            {bodyNodes(c.body, ownTone, props.workspaceId)}
          </p>
        </div>
        {tail ? (
          <time dateTime={c.createdAt} className="px-1 font-mono text-sm tabular-nums text-fg-3">
            {formatTime(c.createdAt)}
          </time>
        ) : null}
        {replyTo !== null ? (
          <div data-plan-comment-actions="" className="-ml-2 flex items-center">
            {quote !== null ? (
              <ReplyPrivatelyButton
                authorUserId={replyTo.authorUserId}
                className="hover:bg-panel-3"
                draft={quote}
              />
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}

/**
 * The comments as a thread. `held` is the session's members (role and photo
 * per author), read synchronously, never fetched here.
 */
export function PlanItemThread(props: {
  comments: readonly ShownComment[];
  workspaceId: string | null;
  me: string | null;
  highlightedId?: string | null;
  /** Offer Reply privately on others' comments, pointing here. Absent: never. */
  replyPrivately?: PlanReplyPrivatelyTarget | null;
}): ReactElement {
  const held =
    props.me !== null && props.workspaceId !== null
      ? peekWorkspaceMembers(props.me, props.workspaceId)
      : null;
  const rows = planThreadRows(props.comments, Date.now());
  return (
    <ol data-plan-thread="" className="flex flex-col">
      {rows.map((row) =>
        row.kind === 'day' ? (
          <PlanDayLine key={row.key} label={row.label} />
        ) : (
          <PlanBubble
            key={row.comment.id}
            row={row}
            workspaceId={props.workspaceId}
            held={held}
            highlighted={props.highlightedId === row.comment.id}
            me={props.me}
            replyPrivately={props.replyPrivately ?? null}
          />
        ),
      )}
    </ol>
  );
}
