// Pure, React-free helpers for the chat post sheet: the agency's waiting line,
// the confirm and toast copy, the media strip's labels, the detail rows and the
// post-changed announcement. The sheet's decisions (which moves a viewer gets,
// their confirms and writes) are not here: they come from pcs/use-post-decisions,
// the one hook Post detail also calls. The sheet never refetches the post:
// every value is derived from the PR 2 card row.

import type { PostCardRow } from '../../../packages/posts/src/reads';
import { formatDate, formatDateTime, formatDueDate } from '@/lib/time';
import type { ViewerSide } from '@/lib/chat/viewer-role';
import { formatLabel } from '@/lib/post-detail-presentation';
import { errorText } from '@/lib/error-copy';
import { POST_CHANGED_EVENT, firstName } from '@/components/chat/post-card';
import { onBehalfSuffix } from '@/components/pages/pcs/roles';

/** The actions that ask first, then move the post. */
export type ConfirmKind = 'approve' | 'reject' | 'send_review';

/**
 * The agency's quiet line on a post in review: "Waiting on approvers since 20
 * Sep" ("Waiting on approvers" without a date); null for anyone else or any
 * other stage. Informational only, never an action.
 */
export function agencyWaitingHint(
  side: ViewerSide,
  post: Pick<PostCardRow, 'stage' | 'stage_entered_at'>,
  /** For tests; the app passes none (the viewer's device zone). */
  timeZone?: string,
): string | null {
  if (side !== 'agency' || post.stage !== 'review') return null;
  const since = formatDate(post.stage_entered_at, undefined, timeZone);
  return since === '' ? 'Waiting on approvers' : `Waiting on approvers since ${since}`;
}

/** "1 slide" / "N slides"; empty for no media. */
function slidesPhrase(count: number): string {
  if (count <= 0) return '';
  return count === 1 ? '1 slide' : `all ${count} slides`;
}

/**
 * How confirm copy names a post: its title, or "this post" when it has none.
 * Never a KEY-N code (codes are not shown in the UI).
 */
export function postSubject(title: string | null | undefined): string {
  const trimmed = (title ?? '').trim();
  return trimmed !== '' ? trimmed : 'this post';
}

/** The confirm block's question and its consequence line. */
export interface ConfirmCopy {
  question: string;
  detail: string;
  confirmLabel: string;
}

/** How the reject confirm names the creator: their first name, or "The creator". */
export function creatorSubject(creatorName: string | null | undefined): string {
  const first = firstName(creatorName ?? '');
  return first !== '' ? first : 'The creator';
}

/**
 * The confirm copy. Reject: "Reject this post?" and who gets it back to rework.
 * Approve: "Approve <Title>, all N slides, for Oct 2?" followed
 * by the logged-approval line; the slide and date clauses drop out when there is
 * no media or no target date. Send for review says what leaving draft means.
 * `subject` is the post's name as postSubject gives it.
 */
export function confirmCopy(
  kind: ConfirmKind,
  args: { subject: string; mediaCount: number; targetDate: string; creatorName?: string | null },
): ConfirmCopy {
  if (kind === 'reject') {
    return {
      question: 'Reject this post?',
      detail: `${creatorSubject(args.creatorName)} gets it back to rework. You can send a reason.`,
      confirmLabel: 'Reject',
    };
  }
  const clauses = [args.subject];
  const slides = slidesPhrase(args.mediaCount);
  if (slides !== '') clauses.push(slides);
  if (args.targetDate !== '') clauses.push(`for ${args.targetDate}`);
  const subject = clauses.join(', ');
  if (kind === 'approve') {
    return {
      question: `Approve ${subject}?`,
      detail: 'This is logged as your approval and the creators are notified.',
      confirmLabel: 'Approve',
    };
  }
  return {
    question: `Send ${args.subject} to the approvers for review?`,
    detail:
      'It leaves draft, and approvers can approve it or comment, or you can approve on their behalf.',
    confirmLabel: 'Send for review',
  };
}

/** The toast after a client comment lands. */
export function commentToast(): string {
  return 'Comment added';
}

/** Copy for a failed comment_batch_create; unknown codes keep the generic line. */
export function friendlyCommentError(code: string): string {
  switch (code) {
    case 'invalid_stage':
      return 'Comments open once the post is in review.';
    case 'invalid_payload':
      return 'Each point needs 1 to 50 words.';
    default:
      return errorText('add the comment', code);
  }
}

/** "m:ss" for a duration in milliseconds; empty for a missing or invalid one. */
export function durationLabel(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '';
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** The minimal gallery item shape the strip reads. */
export interface StripItem {
  kind: string;
  mimeType: string | null;
  durationMs: number | null;
}

/** Whether a gallery item plays as a video. */
export function isVideoItem(item: Pick<StripItem, 'kind' | 'mimeType'>): boolean {
  return item.kind === 'video' || (item.mimeType ?? '').startsWith('video/');
}

/** "Reel · m:ss" for a video-format post whose first video has a duration, else null. */
export function reelLabel(format: string, items: readonly StripItem[]): string | null {
  if (format !== 'video') return null;
  const video = items.find(isVideoItem);
  const length = durationLabel(video?.durationMs ?? null);
  return length === '' ? null : `Reel · ${length}`;
}

/** The strip counter: "1 / N". */
export function stripCounter(index: number, count: number): string {
  return `${index + 1} / ${count}`;
}

/** The sheet title: the format ("Carousel"); the body already shows the post title. */
export function sheetTitle(format: string): string {
  return formatLabel(format);
}

/** Title-case a stage value for its chip. */
export function stageTagLabel(stage: string): string {
  return stage.charAt(0).toUpperCase() + stage.slice(1);
}

/** One key/value row under the title (Stage renders its Tag, so it is not here). */
export interface DetailRow {
  key: 'target' | 'format' | 'approved';
  label: string;
  value: string;
}

/**
 * The rows after Stage: target date, format (with "· N slides" past one item),
 * and the approval. With an approver on record the value is "Name · 2 Oct, 2:05 PM"
 * ("Name on behalf of client · ..." for an agency-side approver); an approved
 * post with no approver reads the date it entered approved. The target date is
 * a due date: its calendar day on the workspace zone; the approval reads the
 * viewer's device zone.
 */
export function detailRows(
  post: Pick<
    PostCardRow,
    | 'stage'
    | 'target_date'
    | 'format'
    | 'mediaCount'
    | 'approved_by'
    | 'approved_at'
    | 'stage_entered_at'
  >,
  approverName: string | null,
  /** For tests; the app passes undefined (the viewer's device zone). */
  timeZone: string | undefined,
  /** The workspace's zone, the target (due) day reads on it. */
  workspaceZone: string | null | undefined,
  approverRole: string | null = null,
  brand: string | null = null,
): DetailRow[] {
  const rows: DetailRow[] = [];
  const target = post.target_date !== null ? formatDueDate(post.target_date, workspaceZone) : '';
  if (target !== '') rows.push({ key: 'target', label: 'Target date', value: target });
  const format = formatLabel(post.format);
  rows.push({
    key: 'format',
    label: 'Format',
    value: post.mediaCount > 1 ? `${format} · ${post.mediaCount} slides` : format,
  });
  if (post.approved_by !== null) {
    const at =
      post.approved_at !== null ? formatDateTime(post.approved_at, undefined, timeZone) : '';
    const who =
      approverName !== null ? `${approverName}${onBehalfSuffix(approverRole, brand)}` : '';
    const value = [who, at].filter((part) => part !== '').join(' · ');
    if (value !== '') rows.push({ key: 'approved', label: 'Approved', value });
  } else if (post.stage === 'approved') {
    const on = formatDate(post.stage_entered_at, undefined, timeZone);
    if (on !== '') rows.push({ key: 'approved', label: 'Approved', value: on });
  }
  return rows;
}

/** Tell every live card batch that a post changed (PR 2's cards refetch on it). */
export function dispatchPostChanged(
  target: Pick<EventTarget, 'dispatchEvent'>,
  postId: string,
): void {
  target.dispatchEvent(new CustomEvent(POST_CHANGED_EVENT, { detail: { postId } }));
}
