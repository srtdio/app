// The feedback ledger on PCS: the post's checkpoint comments (ledger_seq not
// null) as a numbered tick-list with progress. Agency ticks a point done through
// comment_resolve(true) with an optional resolution note, or unticks it with
// comment_resolve(false); the client sees the note on resolved rows, can push
// back with "Not done", and can edit an OPEN point (comment_edit; the server
// clears the tick on edit). "Tell client it's ready" fires post_ready_notify
// once every point is resolved. The component self-fetches the same way
// Comments.tsx does (plain RLS-scoped select + refreshSignal effect) and every
// successful mutation calls onMutated so the ledger and the comment thread
// refetch together. When the post has no checkpoints it renders nothing.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Textarea';
import { IconCheck } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { supabase } from '@/lib/supabase';
import { useNewTrace } from '@/lib/trace-context';
import { useChatAttachments } from '@/lib/chat/use-chat-attachments';
import { MessageAttachments } from '@/components/chat/MessageAttachments';
import { fetchAttachmentMime, toCommentAttachments } from '@/components/comments/Comments';
import {
  countWords,
  counterTone,
  MAX_WORDS,
  OVER_LIMIT_MESSAGE,
} from '@/components/comments/SlotComposer';
import { commentResolve, DOMAIN_ERROR_CODES } from '@srtdio/rpc';
import type { Client, CommentResolveArgs, DomainError, DomainErrorCode, Result } from '@srtdio/rpc';
import { editComment } from '@srtdio/comments';
import type { CommentRow } from '@srtdio/comments';
import type { Stage } from '@srtdio/posts';

/** The ledger read: checkpoint columns only, ordered by seq via the query. */
export const LEDGER_SELECT =
  'id, body, attachment_asset_ids, ledger_seq, ledger_batch_id, resolution_note, resolved_at, resolved_by';

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
>;

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

/** Friendly inline copy for a failed checkpoint comment_edit. The proc enforces
 *  the same 1..50 word cap the composer does, so invalid_payload reuses its line. */
export function friendlyEditError(code: DomainErrorCode | 'invalid_mention'): string {
  return code === 'invalid_payload'
    ? OVER_LIMIT_MESSAGE
    : 'Could not save the edit. Please try again.';
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

// "Stays disabled for the session" is UI-only: a module-level set survives
// remounts and tab switches but never a reload; the proc itself stays callable.
const notifiedThisSession = new Set<string>();
export function wasPostNotified(postId: string): boolean {
  return notifiedThisSession.has(postId);
}
export function markPostNotified(postId: string): void {
  notifiedThisSession.add(postId);
}

/** The tick circle. The check enters/leaves via opacity/translateY only, per the
 *  motion tokens; the fill flips instantly (colour is state, not motion). */
export function tickCircle(done: boolean): ReactElement {
  return (
    <span
      className={cn(
        'flex h-6 w-6 items-center justify-center rounded-full border',
        done ? 'border-good bg-good text-white' : 'border-border text-transparent',
      )}
    >
      <span
        className={cn(
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
    'transition-[opacity,transform] duration-fast ease-enter',
    entered ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0',
  );
}

export interface FeedbackLedgerProps {
  workspaceId: string;
  postId: string;
  postStage: Stage;
  /** True when the viewer's workspace role is 'client'. */
  viewerIsClient: boolean;
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
  refreshSignal,
  onMutated,
  onCounts,
}: FeedbackLedgerProps): ReactElement | null {
  const newTrace = useNewTrace();
  const { presignEnabled, presignCache } = useChatAttachments();

  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [attachmentMime, setAttachmentMime] = useState<Map<string, string>>(new Map());
  const attemptedMime = useRef<Set<string>>(new Set());

  // The checkpoint whose resolve / edit call is in flight; null when idle.
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  // Agency tick flow: the row whose note input is open, its draft, and the
  // one-frame entrance flag for the reveal motion.
  const [noteForId, setNoteForId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [noteEntered, setNoteEntered] = useState(false);
  // Client edit flow (open rows only).
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');

  const [notifySending, setNotifySending] = useState(false);
  const [notifySent, setNotifySent] = useState(() => wasPostNotified(postId));
  const [notifyError, setNotifyError] = useState<string | null>(null);

  // Switching posts drops every per-post state so nothing bleeds across.
  useEffect(() => {
    setRows([]);
    setLoaded(false);
    setBusyId(null);
    setRowError(null);
    setNoteForId(null);
    setNoteDraft('');
    setNoteEntered(false);
    setEditingId(null);
    setEditDraft('');
    setNotifySending(false);
    setNotifySent(wasPostNotified(postId));
    setNotifyError(null);
  }, [postId]);

  // Self-fetch, mirroring Comments.tsx: a plain RLS-scoped select of this post's
  // checkpoint rows (ledger_seq not null, live only), ordered by seq. A failed
  // read keeps whatever was already shown; the comment panel surfaces its own
  // load errors for this entity.
  const load = useCallback(async (): Promise<void> => {
    const { data, error } = await supabase
      .from('comments')
      .select(LEDGER_SELECT)
      .eq('workspace_id', workspaceId)
      .eq('entity_type', 'post')
      .eq('entity_id', postId)
      .not('ledger_seq', 'is', null)
      .is('deleted_at', null)
      .order('ledger_seq', { ascending: true });
    if (error) return;
    setRows(data ?? []);
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

  // Client edit of an OPEN checkpoint; comment_edit re-checks authorship and the
  // 50-word cap, and clears the tick server-side (the refetch shows it cleared).
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

  async function handleNotify(): Promise<void> {
    setNotifyError(null);
    setNotifySending(true);
    const result = await runPostReadyNotify(supabase, { postId, traceId: newTrace() });
    setNotifySending(false);
    if (!result.ok) {
      setNotifyError(notifyErrorMessage(result.error.message));
      return;
    }
    markPostNotified(postId);
    setNotifySent(true);
    onMutated();
  }

  if (rows.length === 0) return null;

  const { resolved, total } = ledgerCounts(rows);
  const open = total - resolved;

  return (
    <section className="rounded-xl border border-border bg-panel-2 p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-fg-3">Checkpoints</span>
        <span className="ml-auto text-xs font-medium tabular-nums text-fg-2">
          {ledgerProgress(resolved, total)}
        </span>
      </div>

      <ol className="flex flex-col">
        {rows.map((row) => {
          const done = row.resolved_at !== null;
          const busy = busyId === row.id;
          const seq = row.ledger_seq ?? 0;
          const attachments = toCommentAttachments(row.attachment_asset_ids, attachmentMime);
          const editing = editingId === row.id;
          const noteOpen = noteForId === row.id;
          const editWords = countWords(editDraft);
          const editTone = counterTone(editWords);
          return (
            <li
              key={row.id}
              className="flex flex-col gap-1.5 border-b border-border py-1.5 first:pt-0 last:border-b-0 last:pb-0"
            >
              <div className="flex items-start gap-2">
                <span
                  aria-hidden
                  className="flex h-11 w-5 shrink-0 items-center justify-center font-mono text-xs font-medium tabular-nums text-fg-3"
                >
                  {seq}
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
                  ) : null}
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
                ) : (
                  <span aria-hidden className="flex h-11 w-11 shrink-0 items-center justify-center">
                    {tickCircle(done)}
                  </span>
                )}
              </div>

              {viewerIsClient && !editing ? (
                <div className="-mt-1 flex items-center pl-7">
                  {done ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="min-h-[44px] min-w-[44px]"
                      disabled={busy}
                      onClick={() => void handleResolve(row.id, false)}
                    >
                      {busy ? 'Saving' : 'Not done'}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="min-h-[44px] min-w-[44px]"
                      disabled={busy}
                      onClick={() => {
                        setRowError(null);
                        setEditDraft(row.body);
                        setEditingId(row.id);
                      }}
                    >
                      Edit
                    </Button>
                  )}
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

              {editing ? (
                <div className="flex flex-col gap-2 pb-2 pl-7">
                  <Textarea
                    autoFocus
                    autoGrow
                    rows={1}
                    aria-label={`Edit checkpoint ${seq}`}
                    value={editDraft}
                    disabled={busy}
                    onChange={(event) => setEditDraft(event.target.value)}
                    style={{ minHeight: '44px' }}
                  />
                  {editTone !== 'hidden' ? (
                    <span
                      className={cn(
                        'self-end pr-1 font-mono text-xs tabular-nums',
                        editTone === 'over' ? 'text-bad' : 'text-warn',
                      )}
                    >
                      {editWords}/{MAX_WORDS}
                    </span>
                  ) : null}
                  {editTone === 'over' ? (
                    <p role="alert" className="text-xs text-bad">
                      {OVER_LIMIT_MESSAGE}
                    </p>
                  ) : null}
                  <div className="flex items-center gap-2">
                    <Button
                      size="lg"
                      variant="primary"
                      disabled={busy || editWords < 1 || editWords > MAX_WORDS}
                      onClick={() => void handleSaveEdit(row.id)}
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

      {!viewerIsClient && postStage === 'review' ? (
        <div className="mt-3 flex flex-col gap-2 border-t border-border pt-3">
          <Button
            size="lg"
            variant="primary"
            disabled={open > 0 || notifySent || notifySending}
            onClick={() => void handleNotify()}
          >
            {notifySent ? 'Client notified' : notifySending ? 'Sending' : NOTIFY_LABEL}
          </Button>
          {notifySent ? (
            <p role="status" className="text-xs text-good">
              The client has been told this post is ready.
            </p>
          ) : open > 0 ? (
            <p className="text-xs text-fg-3">{notifyDisabledReason(open)}</p>
          ) : null}
          {notifyError !== null ? (
            <div role="alert" className="rounded-md border border-bad px-3 py-2 text-sm text-bad">
              {notifyError}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
