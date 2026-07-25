// The post-ready notification on PCS, lifted out of the former FeedbackLedger
// unchanged: the agency's "Tell client it's ready" send (disabled, with a
// count-based reason, while any checkpoint is still open), the post_ready_notify
// call with its error mapping, and the permanent send history read from
// post_ready_notifications newest first. Both sides see the same history, each
// with the wording it has today. When the post has no history and there is no
// send control to show, the notice renders nothing.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { relativeLong } from '@/lib/relative-time';
import { supabase } from '@/lib/supabase';
import { useNewTrace } from '@/lib/trace-context';
import {
  fetchCommentProfiles,
  resolveName,
  type CommentProfile,
} from '@/components/comments/commentProfiles';
import { DOMAIN_ERROR_CODES } from '@srtdio/rpc';
import type { Client, DomainErrorCode, Result } from '@srtdio/rpc';
import type { Stage } from '@srtdio/posts';

export const NOTIFY_LABEL = "Tell client it's ready";

/** The permanent ready-notification record read. */
export const NOTIFICATION_SELECT = 'id, sent_by, checkpoint_count, sent_at';

/** One post_ready_notifications row as the notice selects it. */
export interface NotificationRow {
  id: string;
  sent_by: string | null;
  checkpoint_count: number;
  sent_at: string;
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

/** Which profile ids the record lines need resolved, de-duped. */
function collectProfileIds(notifs: readonly NotificationRow[]): string[] {
  const ids = new Set<string>();
  for (const notif of notifs) {
    if (notif.sent_by !== null) ids.add(notif.sent_by);
  }
  return Array.from(ids);
}

export interface PostReadyNoticeProps {
  workspaceId: string;
  postId: string;
  postStage: Stage;
  /** True when the viewer's workspace role is 'client'. */
  viewerIsClient: boolean;
  /** Open checkpoints (resolved_at null), lifted from the strip's counts so the
   *  send stays disabled with a count-based reason while any remain. */
  openCount: number;
  /** Bumped by the page (shared with the strip and feed) to refetch. */
  refreshSignal: number;
  /** Called after a successful send so the page bumps the shared counter and the
   *  record is read back from post_ready_notifications. */
  onMutated: () => void;
}

export function PostReadyNotice({
  workspaceId,
  postId,
  postStage,
  viewerIsClient,
  openCount,
  refreshSignal,
  onMutated,
}: PostReadyNoticeProps): ReactElement | null {
  const newTrace = useNewTrace();
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [profiles, setProfiles] = useState<Map<string, CommentProfile>>(new Map());
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Switching posts drops the prior record so nothing bleeds across.
  useEffect(() => {
    setNotifications([]);
    setSending(false);
    setError(null);
  }, [postId]);

  // Self-fetch the permanent send history, newest first, and resolve the sending
  // members' display names in one batched read.
  const load = useCallback(async (): Promise<void> => {
    const { data } = await supabase
      .from('post_ready_notifications')
      .select(NOTIFICATION_SELECT)
      .eq('workspace_id', workspaceId)
      .eq('post_id', postId)
      .order('sent_at', { ascending: false });
    const notifs = data ?? [];
    const needed = collectProfileIds(notifs);
    if (needed.length > 0) {
      const fetched = await fetchCommentProfiles(supabase, needed);
      if (fetched.size > 0) setProfiles((prev) => new Map([...prev, ...fetched]));
    }
    setNotifications(notifs);
  }, [workspaceId, postId]);

  useEffect(() => {
    void load();
  }, [load]);

  // A refreshSignal bump refetches; the mount load covers the initial value.
  const lastSignal = useRef(refreshSignal);
  useEffect(() => {
    if (lastSignal.current === refreshSignal) return;
    lastSignal.current = refreshSignal;
    void load();
  }, [refreshSignal, load]);

  async function handleNotify(): Promise<void> {
    setError(null);
    setSending(true);
    const result = await runPostReadyNotify(supabase, { postId, traceId: newTrace() });
    setSending(false);
    if (!result.ok) {
      setError(notifyErrorMessage(result.error.message));
      return;
    }
    // The record is read back from post_ready_notifications on refetch, so the
    // send survives a reload; no in-memory "sent" flag is kept.
    onMutated();
  }

  const view = buildNotificationView(notifications, viewerIsClient);
  const showSend = !viewerIsClient && postStage === 'review';
  if (view === null && !showSend) return null;

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-panel-2 p-4">
      {view !== null ? (
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-fg">{view.headline}</p>
          <p className="text-xs tabular-nums text-fg-3">
            {relativeLong(view.latest.sent_at, new Date())}
            {' · '}
            {checkpointCountLabel(view.latest.checkpoint_count)}
            {view.latest.sent_by !== null && resolveName(profiles, view.latest.sent_by) !== null
              ? ` · ${resolveName(profiles, view.latest.sent_by)}`
              : ''}
          </p>
          {view.earlier.length > 0 ? (
            <ul className="mt-1 flex flex-col gap-1 border-t border-border pt-2">
              {view.earlier.map((notif) => (
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

      {showSend ? (
        <div className="flex flex-col gap-2">
          <Button
            size="lg"
            variant="primary"
            disabled={openCount > 0 || sending}
            onClick={() => void handleNotify()}
          >
            {sending ? 'Sending' : NOTIFY_LABEL}
          </Button>
          {openCount > 0 ? (
            <p className="text-xs text-fg-3">{notifyDisabledReason(openCount)}</p>
          ) : null}
          {error !== null ? (
            <div role="alert" className="rounded-md border border-bad px-3 py-2 text-sm text-bad">
              {error}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
