// The feedback ledger on PCS: the post's checkpoint comments (ledger_seq not
// null) as a numbered tick-list with progress, plus each checkpoint's client
// sub-points and the permanent ready-notification record.
//
// Agency ticks a point done through comment_resolve(true) with an optional note,
// or unticks it with comment_resolve(false). The CLIENT drives the trailing tick
// circle: once the agency has resolved a point, the circle is a live button that
// confirms it through checkpoint_accept(true); a confirmed point can be withdrawn
// through checkpoint_accept(false), which leaves a one-line withdrawal record.
// "Not done" un-resolves through comment_resolve(false). The client can add / edit
// / delete their own sub-points (comment_create reply / comment_edit /
// comment_delete); a sub-point reopens its parent and is capped at 50 words.
// "Tell client it's ready" fires post_ready_notify; the send history is read from
// post_ready_notifications so it survives a reload. The component self-fetches the
// same way Comments.tsx does (plain RLS-scoped selects + refreshSignal effect) and
// every successful mutation calls onMutated so the ledger and the comment thread
// refetch together. When the post has no checkpoints it renders nothing.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Textarea';
import { IconCheck } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { relativeLong } from '@/lib/relative-time';
import { supabase } from '@/lib/supabase';
import { useNewTrace } from '@/lib/trace-context';
import { useChatAttachments } from '@/lib/chat/use-chat-attachments';
import { MessageAttachments } from '@/components/chat/MessageAttachments';
import { fetchAttachmentMime, toCommentAttachments } from '@/components/comments/Comments';
import {
  fetchCommentProfiles,
  resolveName,
  type CommentProfile,
} from '@/components/comments/commentProfiles';
import {
  countWords,
  counterTone,
  MAX_WORDS,
  OVER_LIMIT_MESSAGE,
} from '@/components/comments/SlotComposer';
import { checkpointAccept, commentResolve, DOMAIN_ERROR_CODES } from '@srtdio/rpc';
import type { Client, CommentResolveArgs, DomainError, DomainErrorCode, Result } from '@srtdio/rpc';
import { createComment, deleteSubPoint, editComment } from '@srtdio/comments';
import type { CommentRow } from '@srtdio/comments';
import type { Stage } from '@srtdio/posts';

/** The ledger read: checkpoint columns only, ordered by seq via the query. The
 *  accept columns (accepted_at/by and unaccepted_at/by) drive the client confirm
 *  and withdraw state and the withdrawal record line. */
export const LEDGER_SELECT =
  'id, body, attachment_asset_ids, ledger_seq, ledger_batch_id, resolution_note, resolved_at, resolved_by, author_user_id, edited_at, accepted_at, accepted_by, unaccepted_at, unaccepted_by';

/** One checkpoint row as the ledger selects it. */
export type LedgerRow = Pick<
  CommentRow,
  | 'id'
  | 'body'
  | 'attachment_asset_ids'
  | 'ledger_seq'
  | 'ledger_batch_id'
  | 'resolution_note'
  | 'resolved_at'
  | 'resolved_by'
  | 'author_user_id'
  | 'edited_at'
  | 'accepted_at'
  | 'accepted_by'
  | 'unaccepted_at'
  | 'unaccepted_by'
>;

/** The sub-point read: a checkpoint's client replies. Soft-deleted rows are
 *  fetched too (deleted_at survives) so numbering never shifts under the client;
 *  the render drops the deleted ones and only their number gap remains. */
export const SUBPOINT_SELECT =
  'id, body, author_user_id, parent_comment_id, created_at, deleted_at, edited_at';

/** One sub-point (a reply whose parent is a checkpoint) as the ledger selects it. */
export type SubPointRow = Pick<
  CommentRow,
  'id' | 'body' | 'author_user_id' | 'parent_comment_id' | 'created_at' | 'deleted_at' | 'edited_at'
>;

/** The permanent ready-notification record read. */
export const NOTIFICATION_SELECT = 'id, sent_by, checkpoint_count, sent_at';

/** One post_ready_notifications row as the ledger selects it. */
export interface NotificationRow {
  id: string;
  sent_by: string | null;
  checkpoint_count: number;
  sent_at: string;
}

/** The author of a checkpoint (or sub-point) is the only client who may edit it
 *  (comment_batch_create makes every checkpoint client-authored, so this is
 *  strictly narrower than viewerIsClient). A signed-out viewer ('') is never the
 *  author. */
export function isCheckpointAuthor(
  row: Pick<LedgerRow, 'author_user_id'>,
  viewerUserId: string,
): boolean {
  return viewerUserId !== '' && row.author_user_id === viewerUserId;
}

/** The subtle "edited <time>" marker for an edited checkpoint, reusing the same
 *  relative timestamp the comment thread shows for comment times. Null when the
 *  checkpoint has never been edited. text-fg-3 keeps it muted in both themes. */
export function editedMarker(editedAt: string | null): ReactElement | null {
  if (editedAt === null) return null;
  return (
    <span className="ml-1.5 text-[11px] text-fg-3">
      edited {relativeLong(editedAt, new Date())}
    </span>
  );
}

/** The proc trims and caps the note at 500 chars; the input mirrors the cap. */
export const MAX_NOTE_CHARS = 500;
export const NOTE_PLACEHOLDER = 'What changed (optional, client sees this)';
export const NOTIFY_LABEL = "Tell client it's ready";

export interface LedgerCounts {
  resolved: number;
  total: number;
}

export function ledgerCounts(rows: readonly Pick<LedgerRow, 'resolved_at'>[]): LedgerCounts {
  return {
    resolved: rows.filter((row) => row.resolved_at !== null).length,
    total: rows.length,
  };
}

/** The header progress line. */
export function ledgerProgress(resolved: number, total: number): string {
  return `${resolved} of ${total}`;
}

/**
 * The checkpoint's client-facing state. A checkpoint the agency has not resolved
 * is 'open'; once resolved it is the client's turn ('client_turn') until they
 * confirm it, after which it is 'confirmed'. Confirmed requires resolved, so an
 * agency reopen (resolved_at back to null) drops a confirmed point straight to
 * 'open' regardless of what the accept columns still hold.
 */
export type CheckpointState = 'open' | 'client_turn' | 'confirmed';
export function checkpointState(
  row: Pick<LedgerRow, 'resolved_at' | 'accepted_at'>,
): CheckpointState {
  if (row.resolved_at === null) return 'open';
  return row.accepted_at !== null ? 'confirmed' : 'client_turn';
}

/** The trailing tick circle is a live button only for the client, and only while
 *  it is the client's turn (resolved, unconfirmed). */
export function clientCircleInteractive(
  row: Pick<LedgerRow, 'resolved_at' | 'accepted_at'>,
  viewerIsClient: boolean,
): boolean {
  return viewerIsClient && checkpointState(row) === 'client_turn';
}

/** "Add sub-point" is client-only, and never on a settled (confirmed) point. The
 *  agency never sees it in any state. */
export function showAddSubPoint(viewerIsClient: boolean, state: CheckpointState): boolean {
  return viewerIsClient && state !== 'confirmed';
}

/**
 * The one-line withdrawal record shows only when the client's confirmation was
 * withdrawn: the point is the client's turn again (resolved, unconfirmed) AND an
 * unaccepted stamp exists. An agency un-tick or a sub-point reopen returns the
 * point to 'open' (resolved_at null), so this is false there and the open state
 * is the only signal.
 */
export function showWithdrawalLine(
  row: Pick<LedgerRow, 'resolved_at' | 'accepted_at' | 'unaccepted_at'>,
): boolean {
  return checkpointState(row) === 'client_turn' && row.unaccepted_at !== null;
}

/** The withdrawal record copy, built from the stamp and the withdrawing member's
 *  display name. Anonymous when the id no longer resolves to a member. */
export function withdrawalLine(unacceptedAt: string, name: string | null): string {
  const when = relativeLong(unacceptedAt, new Date());
  return name !== null ? `Withdrawn by ${name} · ${when}` : `Confirmation withdrawn · ${when}`;
}

/** One numbered, live sub-point ready to render. */
export interface NumberedSubPoint {
  row: SubPointRow;
  label: string;
}

/**
 * Number a parent's sub-points as `parentSeq.n` from creation order across ALL
 * sub-points INCLUDING the soft-deleted ones, then drop the deleted rows. The
 * number never shifts under the client and a deletion leaves a visible gap. Rows
 * MUST arrive in created_at ascending order (the query guarantees it).
 */
export function numberSubPoints(
  parentSeq: number,
  rows: readonly SubPointRow[],
): NumberedSubPoint[] {
  return rows
    .map((row, index) => ({ row, label: `${parentSeq}.${index + 1}` }))
    .filter((item) => item.row.deleted_at === null);
}

/** Group sub-points under their parent id, preserving the query's created_at
 *  ascending order so numbering stays stable. */
export function groupSubPoints(rows: readonly SubPointRow[]): Map<string, SubPointRow[]> {
  const byParent = new Map<string, SubPointRow[]>();
  for (const row of rows) {
    if (row.parent_comment_id === null) continue;
    const list = byParent.get(row.parent_comment_id);
    if (list) list.push(row);
    else byParent.set(row.parent_comment_id, [row]);
  }
  return byParent;
}

/** "N checkpoints" (singular at one), for the notification record lines. */
export function checkpointCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'checkpoint' : 'checkpoints'}`;
}

/** The record headline. The client's wording reflects that the agency told them;
 *  the agency's reflects that the client was notified. */
export function notifyHistoryHeadline(viewerIsClient: boolean): string {
  return viewerIsClient
    ? 'The agency told you this post is ready.'
    : 'You told the client this post is ready.';
}

/** The record view: the newest send prominent, the rest as earlier history.
 *  Null when nothing has been sent, so the block renders nothing. */
export interface NotificationView {
  headline: string;
  latest: NotificationRow;
  earlier: NotificationRow[];
}
export function buildNotificationView(
  rows: readonly NotificationRow[],
  viewerIsClient: boolean,
): NotificationView | null {
  if (rows.length === 0) return null;
  const [latest, ...earlier] = rows;
  return { headline: notifyHistoryHeadline(viewerIsClient), latest: latest!, earlier };
}

/**
 * Build the comment_resolve args. The note rides as p_resolution_note ONLY on a
 * resolve (the proc ignores it on reopen and only stores it on a real
 * open-to-resolved transition); a blank note is omitted entirely so the proc's
 * trim-to-null never even sees it. trace is always explicit.
 */
export function buildResolveArgs(input: {
  commentId: string;
  resolved: boolean;
  note?: string;
  traceId: string;
}): CommentResolveArgs {
  const trimmed = input.note?.trim() ?? '';
  return {
    p_comment_id: input.commentId,
    p_resolved: input.resolved,
    p_trace_id: input.traceId,
    ...(input.resolved && trimmed !== '' ? { p_resolution_note: trimmed } : {}),
  };
}

/** Friendly inline copy for a failed comment_resolve. */
export function friendlyResolveError(error: DomainError): string {
  switch (error.code) {
    case 'invalid_payload':
      return `Could not save. Notes are limited to ${MAX_NOTE_CHARS} characters.`;
    case 'forbidden_role':
    case 'workspace_member_only':
      return 'You do not have permission to make this change.';
    default:
      return 'Something went wrong. Please try again.';
  }
}

/** Friendly inline copy for a failed checkpoint / sub-point comment_edit or a
 *  sub-point create. The proc enforces the same 1..50 word cap the composer does,
 *  so invalid_payload reuses its line. */
export function friendlyEditError(code: DomainErrorCode | 'invalid_mention'): string {
  return code === 'invalid_payload'
    ? OVER_LIMIT_MESSAGE
    : 'Could not save. Please try again.';
}

/** Friendly inline copy for a failed checkpoint_accept. invalid_stage sits outside
 *  DOMAIN_ERROR_CODES so it arrives as the raw message; the rest map by code, the
 *  same split runPostReadyNotify uses for its ledger-specific raises. */
export function friendlyAcceptError(error: DomainError): string {
  if (error.message === 'invalid_stage') return 'This checkpoint is not ready to confirm yet.';
  switch (error.code) {
    case 'invalid_payload':
      return 'This is not a checkpoint.';
    case 'forbidden_role':
    case 'workspace_member_only':
      return 'Only the client can confirm a checkpoint.';
    default:
      return 'Something went wrong. Please try again.';
  }
}

/** Friendly inline copy for a failed sub-point comment_delete. */
export function friendlyDeleteError(error: DomainError): string {
  switch (error.code) {
    case 'forbidden_role':
    case 'workspace_member_only':
      return 'You do not have permission to delete this.';
    case 'invalid_payload':
      return 'This item cannot be deleted.';
    default:
      return 'Something went wrong. Please try again.';
  }
}

/** Call post_ready_notify with the same DOMAIN_ERROR_CODES mapping the batch
 *  write in Comments.tsx uses: a raised domain code maps to itself, anything
 *  else to 'unknown', both carrying the raw message for the map below. */
export async function runPostReadyNotify(
  client: Client,
  params: { postId: string; traceId: string },
): Promise<Result<undefined>> {
  const args = { p_post_id: params.postId, p_trace_id: params.traceId };
  const { error } = await client.rpc('post_ready_notify', args);
  if (error) {
    const known = (DOMAIN_ERROR_CODES as readonly string[]).includes(error.message);
    return {
      ok: false,
      error: {
        code: known ? (error.message as DomainErrorCode) : 'unknown',
        message: error.message,
      },
    };
  }
  return { ok: true, data: undefined };
}

/** Map post_ready_notify's raised codes to friendly inline copy. The proc owns
 *  the policy; checkpoints_open / invalid_stage are ledger-specific raises that
 *  sit outside DOMAIN_ERROR_CODES, so this matches on the raw message. */
export function notifyErrorMessage(message: string): string {
  switch (message) {
    case 'checkpoints_open':
      return 'Some checkpoints are still open. Resolve them all first.';
    case 'forbidden_role':
      return 'Only agency members can send this.';
    case 'invalid_stage':
      return 'This post is not in review anymore.';
    default:
      return 'Could not notify the client. Please try again.';
  }
}

/** The inline reason the notify button is disabled, or null when it is not. */
export function notifyDisabledReason(openCount: number): string | null {
  if (openCount <= 0) return null;
  return `Resolve ${openCount} open ${openCount === 1 ? 'checkpoint' : 'checkpoints'} first.`;
}

/** The tick circle. The check enters/leaves via opacity/translateY only, per the
 *  motion tokens; the fill flips instantly (colour is state, not motion). When
 *  `live` (the client's turn, an unfilled circle), the ring/border switches to the
 *  accent line so the circle reads as the one thing to act on. */
export function tickCircle(done: boolean, live = false): ReactElement {
  return (
    <span
      className={cn(
        'flex h-6 w-6 items-center justify-center rounded-full border',
        done ? 'border-good bg-good text-white' : 'border-border text-transparent',
        live && !done ? 'border-accent-line ring-2 ring-accent' : '',
      )}
    >
      <span
        className={cn(
          // axis: opacity + translateY only (no translateX, rotate, scale)
          'transition-[opacity,transform] duration-fast ease-enter',
          done ? 'translate-y-0 opacity-100' : 'translate-y-0.5 opacity-0',
        )}
      >
        <IconCheck size={14} />
      </span>
    </span>
  );
}

/** Note-input reveal classes: opacity/translateY only (the Sheet enter pattern). */
export function noteRevealClass(entered: boolean): string {
  return cn(
    // axis: opacity + translateY only (no translateX, rotate, scale)
    'transition-[opacity,transform] duration-fast ease-enter',
    entered ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0',
  );
}

/** Sub-point composer reveal classes: height + opacity only. */
export function subComposerRevealClass(entered: boolean): string {
  return cn(
    // axis: max-height + opacity only (no translate, rotate, scale)
    'overflow-hidden transition-[max-height,opacity] duration-fast ease-enter',
    entered ? 'max-h-[480px] opacity-100' : 'max-h-0 opacity-0',
  );
}

/** Which profile ids the record and withdrawal lines need resolved, de-duped. */
function collectProfileIds(
  rows: readonly LedgerRow[],
  notifs: readonly NotificationRow[],
): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.unaccepted_by !== null) ids.add(row.unaccepted_by);
    if (row.accepted_by !== null) ids.add(row.accepted_by);
  }
  for (const notif of notifs) {
    if (notif.sent_by !== null) ids.add(notif.sent_by);
  }
  return Array.from(ids);
}

/** A quiet text action: reads as plain text, but carries a 44px minimum touch
 *  target from invisible padding, not from a visible box. */
function QuietAction({
  onClick,
  disabled,
  tone,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  tone?: 'default' | 'bad';
  children: ReactNode;
}): ReactElement {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex min-h-[44px] min-w-[44px] items-center text-sm underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50',
        tone === 'bad' ? 'text-bad' : 'text-fg-2 hover:text-fg',
      )}
    >
      {children}
    </button>
  );
}

export interface FeedbackLedgerProps {
  workspaceId: string;
  postId: string;
  postStage: Stage;
  /** True when the viewer's workspace role is 'client'. */
  viewerIsClient: boolean;
  /** The current viewer's user id ('' when signed out); gates the author-only
   *  edit / delete controls on a checkpoint and its sub-points. */
  viewerUserId: string;
  /** Bumped by the page (shared with Comments) to refetch. */
  refreshSignal: number;
  /** Called after every successful mutation so the page bumps the shared counter. */
  onMutated: () => void;
  /** Lifted counts so the page renders its header chip without a second fetch. */
  onCounts?: (counts: LedgerCounts) => void;
}

export function FeedbackLedger({
  workspaceId,
  postId,
  postStage,
  viewerIsClient,
  viewerUserId,
  refreshSignal,
  onMutated,
  onCounts,
}: FeedbackLedgerProps): ReactElement | null {
  const newTrace = useNewTrace();
  const { presignEnabled, presignCache } = useChatAttachments();

  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [subPoints, setSubPoints] = useState<SubPointRow[]>([]);
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [profiles, setProfiles] = useState<Map<string, CommentProfile>>(new Map());
  const [loaded, setLoaded] = useState(false);
  const [attachmentMime, setAttachmentMime] = useState<Map<string, string>>(new Map());
  const attemptedMime = useRef<Set<string>>(new Set());

  // The row (checkpoint or sub-point) whose write is in flight; null when idle.
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  // Agency tick flow: the row whose note input is open, its draft, and the
  // one-frame entrance flag for the reveal motion.
  const [noteForId, setNoteForId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [noteEntered, setNoteEntered] = useState(false);
  // Edit flow, shared by an open checkpoint (its author) and a sub-point (its
  // author): both go through comment_edit and the same 50-word editor.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  // Client sub-point composer: the parent whose composer is open, its draft, and
  // the one-frame entrance flag for the height/opacity reveal.
  const [composerForId, setComposerForId] = useState<string | null>(null);
  const [subDraft, setSubDraft] = useState('');
  const [composerEntered, setComposerEntered] = useState(false);
  // The sub-point pending a delete confirm; null when none.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const [notifySending, setNotifySending] = useState(false);
  const [notifyError, setNotifyError] = useState<string | null>(null);

  // Switching posts drops every per-post state so nothing bleeds across.
  useEffect(() => {
    setRows([]);
    setSubPoints([]);
    setNotifications([]);
    setLoaded(false);
    setBusyId(null);
    setRowError(null);
    setNoteForId(null);
    setNoteDraft('');
    setNoteEntered(false);
    setEditingId(null);
    setEditDraft('');
    setComposerForId(null);
    setSubDraft('');
    setComposerEntered(false);
    setConfirmDeleteId(null);
    setNotifySending(false);
    setNotifyError(null);
  }, [postId]);

  // Self-fetch, mirroring Comments.tsx: a plain RLS-scoped select of this post's
  // checkpoint rows, then ONE batched IN read of every sub-point (deleted rows
  // included, for stable numbering), then the ready-notification record, then the
  // profiles the withdrawal / record lines name. A failed checkpoint read keeps
  // whatever was already shown; the comment panel surfaces its own load errors.
  const load = useCallback(async (): Promise<void> => {
    const { data: checkpointData, error } = await supabase
      .from('comments')
      .select(LEDGER_SELECT)
      .eq('workspace_id', workspaceId)
      .eq('entity_type', 'post')
      .eq('entity_id', postId)
      .not('ledger_seq', 'is', null)
      .is('deleted_at', null)
      .order('ledger_seq', { ascending: true });
    if (error) return;
    const checkpoints = checkpointData ?? [];

    const parentIds = checkpoints.map((row) => row.id);
    let subs: SubPointRow[] = [];
    if (parentIds.length > 0) {
      const { data: subData } = await supabase
        .from('comments')
        .select(SUBPOINT_SELECT)
        .eq('workspace_id', workspaceId)
        .eq('entity_type', 'post')
        .eq('entity_id', postId)
        .in('parent_comment_id', parentIds)
        .order('created_at', { ascending: true });
      subs = subData ?? [];
    }

    const { data: notifData } = await supabase
      .from('post_ready_notifications')
      .select(NOTIFICATION_SELECT)
      .eq('workspace_id', workspaceId)
      .eq('post_id', postId)
      .order('sent_at', { ascending: false });
    const notifs = notifData ?? [];

    const needed = collectProfileIds(checkpoints, notifs);
    if (needed.length > 0) {
      const fetched = await fetchCommentProfiles(supabase, needed);
      if (fetched.size > 0) setProfiles((prev) => new Map([...prev, ...fetched]));
    }

    setRows(checkpoints);
    setSubPoints(subs);
    setNotifications(notifs);
    setLoaded(true);
  }, [workspaceId, postId]);

  useEffect(() => {
    void load();
  }, [load]);

  // A refreshSignal bump refetches; the mount load covers the initial value
  // (the same guard Comments.tsx uses).
  const lastSignal = useRef(refreshSignal);
  useEffect(() => {
    if (lastSignal.current === refreshSignal) return;
    lastSignal.current = refreshSignal;
    void load();
  }, [refreshSignal, load]);

  // Lift the counts once a fetch has landed so the page chip / tab badge stay
  // derived from this one read.
  useEffect(() => {
    if (!loaded) return;
    onCounts?.(ledgerCounts(rows));
  }, [rows, loaded, onCounts]);

  // One-frame entrance for the note reveal (opacity/translateY only).
  useEffect(() => {
    if (noteForId === null || noteEntered) return;
    const raf = requestAnimationFrame(() => setNoteEntered(true));
    return () => cancelAnimationFrame(raf);
  }, [noteForId, noteEntered]);

  // One-frame entrance for the sub-point composer reveal (height/opacity only).
  useEffect(() => {
    if (composerForId === null || composerEntered) return;
    const raf = requestAnimationFrame(() => setComposerEntered(true));
    return () => cancelAnimationFrame(raf);
  }, [composerForId, composerEntered]);

  // Resolve attachment mimes in one batched read (the existing comment
  // attachment rendering path).
  useEffect(() => {
    const needed: string[] = [];
    for (const row of rows) {
      for (const id of row.attachment_asset_ids ?? []) {
        if (!attemptedMime.current.has(id)) {
          attemptedMime.current.add(id);
          needed.push(id);
        }
      }
    }
    if (needed.length === 0) return;
    let active = true;
    void fetchAttachmentMime(supabase, needed).then((fetched) => {
      if (active && fetched.size > 0) {
        setAttachmentMime((prev) => new Map([...prev, ...fetched]));
      }
    });
    return () => {
      active = false;
    };
  }, [rows]);

  // Tick / untick / "Not done" all flow through comment_resolve; the note rides
  // only on a resolve. On success the page's shared counter round-trips into
  // refreshSignal, so ledger and thread refetch together.
  async function handleResolve(commentId: string, resolved: boolean, note?: string): Promise<void> {
    setRowError(null);
    setBusyId(commentId);
    const args = buildResolveArgs({
      commentId,
      resolved,
      traceId: newTrace(),
      ...(note !== undefined ? { note } : {}),
    });
    const result = await commentResolve(supabase, args);
    setBusyId((current) => (current === commentId ? null : current));
    if (!result.ok) {
      setRowError({ id: commentId, message: friendlyResolveError(result.error) });
      return;
    }
    setNoteForId(null);
    setNoteDraft('');
    setNoteEntered(false);
    onMutated();
  }

  // Client confirm (accepted=true) / withdraw (accepted=false) of a resolved
  // checkpoint. The proc re-checks the client role and that the point is resolved.
  async function handleAccept(commentId: string, accepted: boolean): Promise<void> {
    setRowError(null);
    setBusyId(commentId);
    const result = await checkpointAccept(supabase, {
      p_comment_id: commentId,
      p_accepted: accepted,
      p_trace_id: newTrace(),
    });
    setBusyId((current) => (current === commentId ? null : current));
    if (!result.ok) {
      setRowError({ id: commentId, message: friendlyAcceptError(result.error) });
      return;
    }
    onMutated();
  }

  // Edit an OPEN checkpoint (its author) or a sub-point (its author); comment_edit
  // re-checks authorship and the 50-word cap. Editing a checkpoint clears its tick
  // server-side (the refetch shows it cleared).
  async function handleSaveEdit(commentId: string): Promise<void> {
    const words = countWords(editDraft);
    if (words < 1 || words > MAX_WORDS) return;
    setRowError(null);
    setBusyId(commentId);
    const result = await editComment(supabase, { commentId, body: editDraft }, newTrace());
    setBusyId((current) => (current === commentId ? null : current));
    if (!result.ok) {
      setRowError({ id: commentId, message: friendlyEditError(result.error.code) });
      return;
    }
    setEditingId(null);
    setEditDraft('');
    onMutated();
  }

  // Client adds a sub-point: a reply whose parent is the checkpoint. The proc caps
  // it at 50 words and reopens the parent; the composer mirrors the word cap.
  async function handleAddSubPoint(parentId: string): Promise<void> {
    const words = countWords(subDraft);
    if (words < 1 || words > MAX_WORDS) return;
    setRowError(null);
    setBusyId(parentId);
    const result = await createComment(supabase, {
      workspace_id: workspaceId,
      entity_type: 'post',
      entity_id: postId,
      parent_comment_id: parentId,
      body: subDraft,
      trace_id: newTrace(),
    });
    setBusyId((current) => (current === parentId ? null : current));
    if (!result.ok) {
      setRowError({ id: parentId, message: friendlyEditError(result.error.code) });
      return;
    }
    setComposerForId(null);
    setSubDraft('');
    setComposerEntered(false);
    onMutated();
  }

  // Client deletes their own sub-point via comment_delete (behind a confirm step).
  async function handleDeleteSubPoint(commentId: string): Promise<void> {
    setRowError(null);
    setBusyId(commentId);
    const result = await deleteSubPoint(supabase, { commentId }, newTrace());
    setBusyId((current) => (current === commentId ? null : current));
    if (!result.ok) {
      setRowError({ id: commentId, message: friendlyDeleteError(result.error) });
      return;
    }
    setConfirmDeleteId(null);
    onMutated();
  }

  async function handleNotify(): Promise<void> {
    setNotifyError(null);
    setNotifySending(true);
    const result = await runPostReadyNotify(supabase, { postId, traceId: newTrace() });
    setNotifySending(false);
    if (!result.ok) {
      setNotifyError(notifyErrorMessage(result.error.message));
      return;
    }
    // The record is read back from post_ready_notifications on refetch, so the
    // send survives a reload; no in-memory "sent" flag is kept.
    onMutated();
  }

  if (rows.length === 0) return null;

  const { resolved, total } = ledgerCounts(rows);
  const open = total - resolved;
  const subsByParent = groupSubPoints(subPoints);
  const notificationView = buildNotificationView(notifications, viewerIsClient);

  // The 50-word editor, shared by checkpoint and sub-point edits.
  function renderWordEditor(commentId: string, ariaLabel: string): ReactElement {
    const words = countWords(editDraft);
    const tone = counterTone(words);
    const busy = busyId === commentId;
    return (
      <div className="flex flex-col gap-2 pb-2">
        <Textarea
          autoFocus
          autoGrow
          rows={1}
          aria-label={ariaLabel}
          value={editDraft}
          disabled={busy}
          onChange={(event) => setEditDraft(event.target.value)}
          style={{ minHeight: '44px' }}
        />
        {tone !== 'hidden' ? (
          <span
            className={cn(
              'self-end pr-1 font-mono text-xs tabular-nums',
              tone === 'over' ? 'text-bad' : 'text-warn',
            )}
          >
            {words}/{MAX_WORDS}
          </span>
        ) : null}
        {tone === 'over' ? (
          <p role="alert" className="text-xs text-bad">
            {OVER_LIMIT_MESSAGE}
          </p>
        ) : null}
        <div className="flex items-center gap-2">
          <Button
            size="lg"
            variant="primary"
            disabled={busy || words < 1 || words > MAX_WORDS}
            onClick={() => void handleSaveEdit(commentId)}
          >
            {busy ? 'Saving' : 'Save'}
          </Button>
          <Button
            size="lg"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setEditingId(null);
              setEditDraft('');
            }}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <section className="rounded-xl border border-border bg-panel-2 p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-fg-3">Checkpoints</span>
        <span className="ml-auto text-xs font-medium tabular-nums text-fg-2">
          {ledgerProgress(resolved, total)}
        </span>
      </div>

      <ol className="flex flex-col gap-2">
        {rows.map((row) => {
          const state = checkpointState(row);
          const done = row.resolved_at !== null;
          const busy = busyId === row.id;
          const seq = row.ledger_seq ?? 0;
          const attachments = toCommentAttachments(row.attachment_asset_ids, attachmentMime);
          const editing = editingId === row.id;
          const noteOpen = noteForId === row.id;
          const composerOpen = composerForId === row.id;
          const clientTurn = clientCircleInteractive(row, viewerIsClient);
          const isAuthor = isCheckpointAuthor(row, viewerUserId);
          const withdrawn = showWithdrawalLine(row);
          const rowSubs = numberSubPoints(seq, subsByParent.get(row.id) ?? []);
          // Client actions beneath the row, by state. Edit stays author-only on an
          // open checkpoint; "Not done" un-resolves; "Add sub-point" is client-only
          // and off a settled row; "Undo" withdraws a confirmation.
          const showEdit = viewerIsClient && state === 'open' && isAuthor && !editing;
          const showNotDone = viewerIsClient && state === 'client_turn';
          const showUndo = viewerIsClient && state === 'confirmed';
          const showAdd =
            showAddSubPoint(viewerIsClient, state) && !composerOpen && !editing;
          const hasClientActions = showEdit || showNotDone || showUndo || showAdd;
          return (
            <li
              key={row.id}
              className={cn(
                'flex flex-col gap-1.5 rounded-lg border bg-panel p-3',
                clientTurn ? 'border-accent-line' : 'border-border',
              )}
            >
              <div className="flex items-start gap-2">
                <span aria-hidden className="flex h-11 shrink-0 items-center">
                  <span className="flex h-6 min-w-6 items-center justify-center rounded-md bg-panel-2 px-1.5 font-mono text-xs font-medium tabular-nums text-fg-3">
                    {seq}
                  </span>
                </span>
                <div className="min-w-0 flex-1 py-2.5">
                  {!editing ? (
                    <>
                      <p
                        className={cn(
                          'text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]',
                          done ? 'text-fg-2' : 'text-fg',
                        )}
                      >
                        {row.body}
                        {editedMarker(row.edited_at)}
                      </p>
                      {attachments.length > 0 ? (
                        <div className="mt-1.5">
                          <MessageAttachments
                            attachments={attachments}
                            cache={presignCache}
                            presignEnabled={presignEnabled}
                          />
                        </div>
                      ) : null}
                      {done && row.resolution_note !== null ? (
                        <p className="mt-1.5 w-fit rounded-md bg-panel-3 px-2.5 py-1.5 text-xs text-fg-2">
                          {row.resolution_note}
                        </p>
                      ) : null}
                    </>
                  ) : (
                    renderWordEditor(row.id, `Edit checkpoint ${seq}`)
                  )}
                </div>
                {!viewerIsClient ? (
                  <button
                    type="button"
                    aria-pressed={done}
                    aria-label={done ? `Reopen checkpoint ${seq}` : `Mark checkpoint ${seq} done`}
                    disabled={busy}
                    onClick={() => {
                      if (done) {
                        void handleResolve(row.id, false);
                        return;
                      }
                      setRowError(null);
                      setNoteDraft('');
                      setNoteEntered(false);
                      setNoteForId(row.id);
                    }}
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-panel-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
                  >
                    {tickCircle(done)}
                  </button>
                ) : clientTurn ? (
                  <button
                    type="button"
                    aria-label={`Confirm checkpoint ${seq}`}
                    disabled={busy}
                    onClick={() => void handleAccept(row.id, true)}
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-panel-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
                  >
                    {tickCircle(false, true)}
                  </button>
                ) : (
                  <span aria-hidden className="flex h-11 w-11 shrink-0 items-center justify-center">
                    {tickCircle(done)}
                  </span>
                )}
              </div>

              {rowSubs.length > 0 ? (
                <ol className="flex flex-col gap-1.5 pl-7">
                  {rowSubs.map(({ row: sub, label }) => {
                    const subEditing = editingId === sub.id;
                    const subBusy = busyId === sub.id;
                    const subAuthor = isCheckpointAuthor(sub, viewerUserId);
                    const confirming = confirmDeleteId === sub.id;
                    return (
                      <li key={sub.id} className="flex flex-col gap-1">
                        <div className="flex items-start gap-2">
                          <span className="shrink-0 pt-0.5 font-mono text-xs tabular-nums text-fg-3">
                            {label}
                          </span>
                          <div className="min-w-0 flex-1">
                            {!subEditing ? (
                              <p className="text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] text-fg-2">
                                {sub.body}
                                {editedMarker(sub.edited_at)}
                              </p>
                            ) : (
                              renderWordEditor(sub.id, `Edit sub-point ${label}`)
                            )}
                          </div>
                        </div>
                        {subAuthor && !subEditing ? (
                          confirming ? (
                            <div className="flex flex-col gap-1 pl-7">
                              <p className="text-xs text-fg-2">
                                Delete this sub-point? This cannot be undone.
                              </p>
                              <div className="flex items-center gap-3">
                                <QuietAction
                                  tone="bad"
                                  disabled={subBusy}
                                  onClick={() => void handleDeleteSubPoint(sub.id)}
                                >
                                  {subBusy ? 'Deleting' : 'Delete'}
                                </QuietAction>
                                <QuietAction
                                  disabled={subBusy}
                                  onClick={() => setConfirmDeleteId(null)}
                                >
                                  Cancel
                                </QuietAction>
                              </div>
                            </div>
                          ) : (
                            <div className="flex items-center gap-3 pl-7">
                              <QuietAction
                                disabled={subBusy}
                                onClick={() => {
                                  setRowError(null);
                                  setConfirmDeleteId(null);
                                  setEditDraft(sub.body);
                                  setEditingId(sub.id);
                                }}
                              >
                                Edit
                              </QuietAction>
                              <QuietAction
                                tone="bad"
                                disabled={subBusy}
                                onClick={() => {
                                  setRowError(null);
                                  setConfirmDeleteId(sub.id);
                                }}
                              >
                                Delete
                              </QuietAction>
                            </div>
                          )
                        ) : null}
                        {rowError !== null && rowError.id === sub.id ? (
                          <div
                            role="alert"
                            className="ml-7 rounded-md border border-bad px-3 py-2 text-sm text-bad"
                          >
                            {rowError.message}
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ol>
              ) : null}

              {withdrawn && row.unaccepted_at !== null ? (
                <p className="pl-7 text-xs text-fg-3">
                  {withdrawalLine(
                    row.unaccepted_at,
                    row.unaccepted_by !== null ? resolveName(profiles, row.unaccepted_by) : null,
                  )}
                </p>
              ) : null}

              {hasClientActions ? (
                <div className="-mt-0.5 flex flex-wrap items-center gap-3 pl-7">
                  {showNotDone ? (
                    <QuietAction disabled={busy} onClick={() => void handleResolve(row.id, false)}>
                      {busy ? 'Saving' : 'Not done'}
                    </QuietAction>
                  ) : null}
                  {showUndo ? (
                    <QuietAction disabled={busy} onClick={() => void handleAccept(row.id, false)}>
                      {busy ? 'Saving' : 'Undo'}
                    </QuietAction>
                  ) : null}
                  {showEdit ? (
                    <QuietAction
                      disabled={busy}
                      onClick={() => {
                        setRowError(null);
                        setEditDraft(row.body);
                        setEditingId(row.id);
                      }}
                    >
                      Edit
                    </QuietAction>
                  ) : null}
                  {showAdd ? (
                    <QuietAction
                      disabled={busy}
                      onClick={() => {
                        setRowError(null);
                        setSubDraft('');
                        setComposerEntered(false);
                        setComposerForId(row.id);
                      }}
                    >
                      Add sub-point
                    </QuietAction>
                  ) : null}
                </div>
              ) : null}

              {composerOpen ? (
                <div className={cn('pl-7', subComposerRevealClass(composerEntered))}>
                  <div className="flex flex-col gap-2 pt-1.5 pb-2">
                    <Textarea
                      autoFocus
                      autoGrow
                      rows={1}
                      aria-label={`Add a sub-point to checkpoint ${seq}`}
                      placeholder="Add a sub-point (max 50 words)"
                      value={subDraft}
                      disabled={busy}
                      onChange={(event) => setSubDraft(event.target.value)}
                      style={{ minHeight: '44px' }}
                    />
                    {counterTone(countWords(subDraft)) !== 'hidden' ? (
                      <span
                        className={cn(
                          'self-end pr-1 font-mono text-xs tabular-nums',
                          counterTone(countWords(subDraft)) === 'over' ? 'text-bad' : 'text-warn',
                        )}
                      >
                        {countWords(subDraft)}/{MAX_WORDS}
                      </span>
                    ) : null}
                    {counterTone(countWords(subDraft)) === 'over' ? (
                      <p role="alert" className="text-xs text-bad">
                        {OVER_LIMIT_MESSAGE}
                      </p>
                    ) : null}
                    {done ? (
                      <p className="text-xs text-warn">
                        Adding a sub-point will reopen this checkpoint.
                      </p>
                    ) : null}
                    <div className="flex items-center gap-2">
                      <Button
                        size="lg"
                        variant="primary"
                        disabled={
                          busy ||
                          countWords(subDraft) < 1 ||
                          countWords(subDraft) > MAX_WORDS
                        }
                        onClick={() => void handleAddSubPoint(row.id)}
                      >
                        {busy ? 'Saving' : done ? 'Reopen and add' : 'Add sub-point'}
                      </Button>
                      <Button
                        size="lg"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => {
                          setComposerForId(null);
                          setSubDraft('');
                          setComposerEntered(false);
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                </div>
              ) : null}

              {noteOpen ? (
                <div className={cn('flex flex-col gap-2 pb-2 pl-7', noteRevealClass(noteEntered))}>
                  <Textarea
                    autoFocus
                    autoGrow
                    rows={1}
                    maxLength={MAX_NOTE_CHARS}
                    aria-label={`Resolution note for checkpoint ${seq}`}
                    placeholder={NOTE_PLACEHOLDER}
                    value={noteDraft}
                    disabled={busy}
                    onChange={(event) => setNoteDraft(event.target.value)}
                    style={{ minHeight: '44px' }}
                  />
                  <div className="flex items-center gap-2">
                    <Button
                      size="lg"
                      variant="primary"
                      disabled={busy}
                      onClick={() => void handleResolve(row.id, true, noteDraft)}
                    >
                      {busy ? 'Saving' : 'Mark done'}
                    </Button>
                    <Button
                      size="lg"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        setNoteForId(null);
                        setNoteDraft('');
                        setNoteEntered(false);
                      }}
                    >
                      Cancel
                    </Button>
                    <span className="ml-auto text-xs tabular-nums text-fg-3">
                      {noteDraft.length}/{MAX_NOTE_CHARS}
                    </span>
                  </div>
                </div>
              ) : null}

              {rowError !== null && rowError.id === row.id ? (
                <div
                  role="alert"
                  className="ml-7 rounded-md border border-bad px-3 py-2 text-sm text-bad"
                >
                  {rowError.message}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>

      {notificationView !== null || (!viewerIsClient && postStage === 'review') ? (
        <div className="mt-3 flex flex-col gap-3 border-t border-border pt-3">
          {notificationView !== null ? (
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium text-fg">{notificationView.headline}</p>
              <p className="text-xs tabular-nums text-fg-3">
                {relativeLong(notificationView.latest.sent_at, new Date())}
                {' · '}
                {checkpointCountLabel(notificationView.latest.checkpoint_count)}
                {notificationView.latest.sent_by !== null &&
                resolveName(profiles, notificationView.latest.sent_by) !== null
                  ? ` · ${resolveName(profiles, notificationView.latest.sent_by)}`
                  : ''}
              </p>
              {notificationView.earlier.length > 0 ? (
                <ul className="mt-1 flex flex-col gap-1 border-t border-border pt-2">
                  {notificationView.earlier.map((notif) => (
                    <li key={notif.id} className="text-xs tabular-nums text-fg-3">
                      {relativeLong(notif.sent_at, new Date())}
                      {' · '}
                      {checkpointCountLabel(notif.checkpoint_count)}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {!viewerIsClient && postStage === 'review' ? (
            <div className="flex flex-col gap-2">
              <Button
                size="lg"
                variant="primary"
                disabled={open > 0 || notifySending}
                onClick={() => void handleNotify()}
              >
                {notifySending ? 'Sending' : NOTIFY_LABEL}
              </Button>
              {open > 0 ? <p className="text-xs text-fg-3">{notifyDisabledReason(open)}</p> : null}
              {notifyError !== null ? (
                <div role="alert" className="rounded-md border border-bad px-3 py-2 text-sm text-bad">
                  {notifyError}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
