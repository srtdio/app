// Marks surfaces for the open thread: the pin board (Open and History tabs,
// opened from the status drawer's "See all" and the chat info pages) and the
// pending priority chooser.
// Rows come from the channel's mark rows (one read per open) plus the marked
// messages; a body-less message shows its shared post or brief title, resolved
// in ONE batched read per kind while the sheet is open. Tapping a row closes the
// sheet and jumps to the message. Every Open row carries a 44x44 stamp
// (Delivered / Closed / Completed) and every History row a 44x44 Reopen; both
// ask first in an inline confirm inside the row (a height change only, no
// browser dialog). Colours are design tokens only, so light and dark match.
// The Open tab lists the posts waiting in review above the marks, each with
// Jump (a card is in this chat) or Share here.

import { useEffect, useMemo, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
import { EmptyState } from '@/components/ui/EmptyState';
import { Sheet } from '@/components/ui/Sheet';
import { IconBookmark, IconCheck, IconPipeline, IconRotateCcw } from '@/components/ui/icons';
import { Tag } from '@/components/ui/Tag';
import { useToast } from '@/components/ui/toast';
import { MARK_TONE } from '@/components/chat/MarkBits';
import { PRESIGN_ENABLED, sharedCardPresignCache } from '@/components/chat/PostCard';
import { useThumbnail } from '@/components/media/use-thumbnail';
import { formatEntityRef } from '@/lib/entityRef';
import { formatLabel } from '@/lib/post-detail-presentation';
import { supabase } from '@/lib/supabase';
import { useWorkspace } from '@/lib/workspace-context';
import { readPostsByIds } from '@srtdio/posts';
import type { ChatProfile } from '@/lib/chat-reads';
import { readBriefsByIds } from '@/lib/chat/briefs';
import { readPlanTitles } from '@/lib/chat/plans';
import { formatClockTime, formatShortDate } from '@/lib/chat/time-format';
import type { OpenPostRow } from '@/lib/chat/use-open-posts';
import type { WriteResult } from '@/lib/chat/record';
import type { ThreadMessage } from '@/lib/chat/thread';
import {
  MARK_TABS,
  MARK_UPDATE_FAILED,
  STAMP_WORD,
  TYPE_LABEL,
  markConfirmAction,
  markConfirmCopy,
  markRowText,
  markTabCounts,
  marksForTab,
  priorityLabel,
  resolverName,
  type ChatMark,
  type MarkPriority,
  type MarkTab,
  type MarkTransition,
} from '@/lib/chat/marks';

/** The marks section body when posts are listed but no mark is open. */
export const NO_OPEN_MARKS = 'No open marks';

/** The 44px cover of an open post (lazy, same presign path as the cards); KEY tile without one. */
function OpenPostThumb(props: { assetVersionId: string | null; monogram: string | null }) {
  const thumb = useThumbnail<HTMLSpanElement>({
    assetVersionId: props.assetVersionId,
    cache: sharedCardPresignCache(),
    enabled: PRESIGN_ENABLED,
  });
  return (
    <span
      ref={thumb.ref}
      aria-hidden="true"
      data-open-post-thumb=""
      className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-md bg-panel-3 font-mono text-[11px] font-semibold text-fg-3"
    >
      {thumb.url !== null && !thumb.failed ? (
        <img
          src={thumb.url}
          alt=""
          loading="lazy"
          onError={thumb.onError}
          className="h-full w-full object-cover"
        />
      ) : props.monogram !== null ? (
        props.monogram
      ) : (
        <IconPipeline size={16} />
      )}
    </span>
  );
}

export const IN_THIS_CHAT = 'in this chat';
export const NOT_SHARED_HERE = 'not shared here yet';

/** The two text lines of an open post row; target_date is a timestamptz, shown in the workspace zone. Pure. */
export function openPostLines(
  post: OpenPostRow,
  workspaceKey: string | null,
  shared: boolean,
  timeZone: string,
): { title: string; meta: string } {
  const ref =
    workspaceKey !== null && workspaceKey !== ''
      ? formatEntityRef(workspaceKey, post.number)
      : null;
  const date = post.target_date !== null ? formatShortDate(post.target_date, timeZone) : '';
  return {
    title: ref !== null ? `${ref} · ${post.title}` : post.title,
    meta: [formatLabel(post.format), date, shared ? IN_THIS_CHAT : NOT_SHARED_HERE]
      .filter((part) => part !== '')
      .join(' · '),
  };
}

/** One 64px open post row. Hook-free (the thumb is its own component), so tests walk it. */
export function OpenPostSheetRow(props: {
  post: OpenPostRow;
  workspaceKey: string | null;
  shared: boolean;
  /** The workspace IANA zone the target date renders in. */
  timeZone: string;
  onJump: () => void;
  onShare: () => void;
}): ReactElement {
  const lines = openPostLines(props.post, props.workspaceKey, props.shared, props.timeZone);
  const key =
    props.workspaceKey !== null && props.workspaceKey !== ''
      ? props.workspaceKey.toUpperCase()
      : null;
  return (
    <li
      data-open-post={props.post.id}
      className="flex h-16 items-center gap-3 border-b border-border px-2 last:border-b-0"
    >
      <OpenPostThumb assetVersionId={props.post.thumbnailAssetVersionId} monogram={key} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium text-fg">{lines.title}</span>
        <span className="truncate text-xs text-fg-3">{lines.meta}</span>
      </span>
      <Button
        type="button"
        size="lg"
        data-open-post-action={props.shared ? 'jump' : 'share'}
        onClick={props.shared ? props.onJump : props.onShare}
        className={ROW_ACTION}
      >
        {props.shared ? 'Jump' : 'Share here'}
      </Button>
    </li>
  );
}

/** The Open tab's posts section input, from the thread. */
export interface OpenPostsSection {
  heading: string;
  /** Rows, or null while unread / after a failed read (the section is left out). */
  posts: OpenPostRow[] | null;
  workspaceKey: string | null;
  /** Posts that have a card in the loaded thread. */
  sharedIds: ReadonlySet<string>;
  onJump: (postId: string) => void;
  onShare: (postId: string) => void;
}

/** The posts section above the Open marks; nothing when no post is waiting. */
export function OpenPostsList(props: OpenPostsSection & { timeZone: string }): ReactElement | null {
  if (props.posts === null || props.posts.length === 0) return null;
  return (
    <section data-open-posts="" className="flex flex-col gap-1">
      <h3 className="px-2 text-xs font-semibold text-fg-3">{props.heading}</h3>
      <ul className="flex max-h-[40vh] flex-col overflow-y-auto">
        {props.posts.map((post) => (
          <OpenPostSheetRow
            key={post.id}
            post={post}
            workspaceKey={props.workspaceKey}
            shared={props.sharedIds.has(post.id)}
            timeZone={props.timeZone}
            onJump={() => props.onJump(post.id)}
            onShare={() => props.onShare(post.id)}
          />
        ))}
      </ul>
    </section>
  );
}

export function messageTime(mark: ChatMark, message: ThreadMessage | undefined): number {
  if (message !== undefined && message.createdAt !== '') return message.time;
  const t = Date.parse(mark.markedAt);
  return Number.isNaN(t) ? 0 : t;
}

/** Titles for shared posts, briefs and plans of body-less marked messages, keyed by message id. */
export function useCardTitles(
  open: boolean,
  messages: readonly ThreadMessage[],
): Map<string, string> {
  const { workspaceId } = useWorkspace();
  const [titles, setTitles] = useState<Map<string, string>>(new Map());
  const bodyless = useMemo(
    () =>
      messages.filter(
        (m) =>
          m.body.trim() === '' &&
          (m.sharedPostIds.length > 0 ||
            m.sharedBriefIds.length > 0 ||
            (m.sharedPlanIds ?? []).length > 0),
      ),
    [messages],
  );
  const key = bodyless.map((m) => m.id).join(',');
  useEffect(() => {
    if (!open || workspaceId === null || bodyless.length === 0) return;
    let cancelled = false;
    const postIds = [...new Set(bodyless.flatMap((m) => m.sharedPostIds))];
    const briefIds = [...new Set(bodyless.flatMap((m) => m.sharedBriefIds))];
    const planIds = [...new Set(bodyless.flatMap((m) => m.sharedPlanIds ?? []))];
    void Promise.all([
      readPostsByIds(supabase, { workspaceId, ids: postIds }),
      readBriefsByIds(supabase, { workspaceId, ids: briefIds }),
      readPlanTitles(supabase, planIds),
    ]).then(([posts, briefs, plans]) => {
      if (cancelled) return;
      const byId = new Map<string, string>();
      if (posts.ok) for (const p of posts.data) byId.set(p.id, p.title);
      if (briefs.ok) for (const b of briefs.data) byId.set(b.id, b.title);
      if (plans.ok) for (const p of plans.data) byId.set(p.id, p.title);
      const next = new Map<string, string>();
      for (const m of bodyless) {
        const first = [...m.sharedPostIds, ...m.sharedBriefIds, ...(m.sharedPlanIds ?? [])].find(
          (id) => byId.has(id),
        );
        if (first !== undefined) next.set(m.id, byId.get(first) ?? '');
      }
      setTitles(next);
    });
    return () => {
      cancelled = true;
    };
    // `key` stands for the body-less id set; `bodyless` is derived from it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workspaceId, key]);
  return titles;
}

/**
 * Run a confirmed stamp or reopen. The hook has already moved the row and
 * moves it back on failure; this only adds the toast. Pure so it is tested
 * with a fake handler and toast.
 */
export async function confirmMarkTransition(params: {
  action: MarkTransition;
  messageId: string;
  onResolve: (messageId: string) => Promise<WriteResult>;
  onReopen: (messageId: string) => Promise<WriteResult>;
  toast: { show: (toast: { title: string }) => void };
}): Promise<WriteResult> {
  const run = params.action === 'resolve' ? params.onResolve : params.onReopen;
  const result = await run(params.messageId);
  if (!result.ok) params.toast.show({ title: MARK_UPDATE_FAILED });
  return result;
}

/** 44x44 minimum, right-aligned row action (stamp or Reopen): a default lg Button. */
const ROW_ACTION = 'min-w-[44px] shrink-0 gap-1 px-3';

/**
 * One pin board row. Hook-free so the stamp word, confirm copy and History
 * block are unit-tested by walking the returned tree.
 */
export function MarkSheetRow(props: {
  mark: ChatMark;
  sender: string;
  text: string;
  /** Marked message time (or marked_at) on the workspace clock. */
  when: string;
  /** History rows: who stamped it and when. */
  resolver?: { name: string; when: string };
  confirming: boolean;
  busy: boolean;
  onJump: () => void;
  onAsk: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactElement {
  const { mark } = props;
  const action: MarkTransition = mark.resolved ? 'reopen' : 'resolve';
  const priority = !mark.resolved && mark.type === 'pending' ? priorityLabel(mark.priority) : '';
  return (
    <li
      data-mark-row={mark.messageId}
      className="flex flex-col border-b border-border py-1 last:border-b-0"
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={props.onJump}
          className="flex min-h-[44px] min-w-0 flex-1 flex-col gap-1 rounded-md px-2 py-2 text-left transition-colors hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <span className="flex min-w-0 items-center gap-2 text-xs text-fg-3">
            <Tag label={TYPE_LABEL[mark.type]} tone={MARK_TONE[mark.type]} className="shrink-0" />
            {priority !== '' ? <Tag label={priority} tone="warn" className="shrink-0" /> : null}
            <span className="truncate font-medium text-fg">{props.sender}</span>
            <span className="ml-auto shrink-0">{props.when}</span>
          </span>
          <span className="line-clamp-2 [overflow-wrap:anywhere] text-sm text-fg-2">
            {props.text}
          </span>
        </button>
        {props.resolver !== undefined ? (
          <div data-mark-history="" className="flex shrink-0 flex-col items-end gap-1 text-right">
            <span className="text-xs font-semibold text-fg">{STAMP_WORD[mark.type]}</span>
            <span className="text-[11px] text-fg-3">
              {`${props.resolver.name} · ${props.resolver.when}`}
            </span>
            <Button
              type="button"
              size="lg"
              data-mark-action="reopen"
              aria-expanded={props.confirming}
              disabled={props.busy}
              onClick={props.onAsk}
              className={ROW_ACTION}
            >
              <IconRotateCcw size={14} />
              <span>Reopen</span>
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            size="lg"
            data-mark-action="resolve"
            aria-expanded={props.confirming}
            disabled={props.busy}
            onClick={props.onAsk}
            className={ROW_ACTION}
          >
            <IconCheck size={14} />
            <span>{STAMP_WORD[mark.type]}</span>
          </Button>
        )}
      </div>
      {props.confirming ? (
        <div
          role="group"
          aria-label={markConfirmCopy(mark.type, action)}
          data-mark-confirm={action}
          className="mx-2 mb-1 flex flex-wrap items-center gap-2 rounded-md border border-border bg-panel-2 px-3 py-2"
        >
          <span className="min-w-0 flex-1 text-sm text-fg">
            {markConfirmCopy(mark.type, action)}
          </span>
          <Button variant="ghost" size="lg" disabled={props.busy} onClick={props.onCancel}>
            Cancel
          </Button>
          <Button variant="primary" size="lg" disabled={props.busy} onClick={props.onConfirm}>
            {markConfirmAction(mark.type, action)}
          </Button>
        </div>
      ) : null}
    </li>
  );
}

/** What the pin board list needs: the marks, their messages, and the row actions. */
export interface MarksListProps {
  /** The surface showing the list is open: gates the title read and resets confirms. */
  open: boolean;
  marks: Map<string, ChatMark>;
  /** The marked message, from the loaded thread or the marks read. */
  messageFor: (messageId: string) => ThreadMessage | undefined;
  profiles: Map<string, ChatProfile>;
  currentUserId: string;
  timeZone: string;
  onJump: (messageId: string) => void;
  onResolve: (messageId: string) => Promise<WriteResult>;
  onReopen: (messageId: string) => Promise<WriteResult>;
  /** Posts waiting in review, listed first on the Open tab (the thread sheet only). */
  openPosts?: OpenPostsSection;
  /**
   * Cap each tab at the first `rows` rows (the chat info preview); `seeAll`
   * shows under a tab that holds more. Absent lists every row.
   */
  preview?: { rows: number; seeAll: ReactNode };
}

/**
 * What sits under the tabs after the posts section: the mark rows; a muted "No
 * open marks" line when posts are listed above but no mark is open; else the
 * full empty state. Pure.
 */
export function marksListBody(
  tab: MarkTab,
  markRows: number,
  openPostRows: number,
): 'rows' | 'no-open-marks' | 'empty' {
  if (markRows > 0) return 'rows';
  return tab === 'open' && openPostRows > 0 ? 'no-open-marks' : 'empty';
}

/**
 * The pin board body (Open and History tabs, rows, stamp and reopen confirms),
 * shared by MarksSheet and the DM Contact sheet's Marks tab.
 */
export function MarksList(props: MarksListProps): ReactElement {
  const [tab, setTab] = useState<MarkTab>('open');
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const { messageFor, profiles } = props;

  // A closed sheet or a tab switch drops any half-asked confirm.
  useEffect(() => setConfirming(null), [props.open, tab]);

  const rows = useMemo(
    () => marksForTab(props.marks.values(), tab, (m) => messageTime(m, messageFor(m.messageId))),
    [props.marks, tab, messageFor],
  );
  const markedMessages = useMemo(() => {
    const list: ThreadMessage[] = [];
    for (const mark of props.marks.values()) {
      const message = messageFor(mark.messageId);
      if (message !== undefined) list.push(message);
    }
    return list;
  }, [props.marks, messageFor]);
  const titles = useCardTitles(props.open, markedMessages);
  const shownRows = props.preview !== undefined ? rows.slice(0, props.preview.rows) : rows;
  const tabCount = markTabCounts(props.marks.values());
  const body = marksListBody(tab, rows.length, props.openPosts?.posts?.length ?? 0);
  const displayNameOf = (userId: string): string | undefined => profiles.get(userId)?.displayName;

  async function confirm(mark: ChatMark): Promise<void> {
    if (busy) return;
    setBusy(true);
    setConfirming(null);
    await confirmMarkTransition({
      action: mark.resolved ? 'reopen' : 'resolve',
      messageId: mark.messageId,
      onResolve: props.onResolve,
      onReopen: props.onReopen,
      toast,
    });
    setBusy(false);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2" role="tablist">
        {MARK_TABS.map((option) => (
          <Chip
            key={option.key}
            label={`${option.label} (${tabCount[option.key]})`}
            size="tap"
            selected={tab === option.key}
            onClick={() => setTab(option.key)}
          />
        ))}
      </div>
      {tab === 'open' && props.openPosts !== undefined ? (
        <OpenPostsList {...props.openPosts} timeZone={props.timeZone} />
      ) : null}
      {body === 'no-open-marks' ? (
        <p data-no-open-marks="" className="px-2 text-xs text-fg-3">
          {NO_OPEN_MARKS}
        </p>
      ) : body === 'empty' ? (
        <EmptyState
          icon={<IconBookmark size={22} />}
          title="Nothing here"
          description={
            tab === 'open' ? 'No open marks in this chat.' : 'Nothing has been stamped yet.'
          }
        />
      ) : (
        <ul className="flex max-h-[55vh] flex-col overflow-y-auto">
          {shownRows.map((mark) => {
            const message = messageFor(mark.messageId);
            const sender =
              message === undefined
                ? 'Member'
                : message.mine
                  ? 'You'
                  : ((message.senderUserId !== null
                      ? displayNameOf(message.senderUserId)
                      : undefined) ?? 'Member');
            const when =
              message !== undefined && message.createdAt !== ''
                ? formatClockTime(message.createdAt, props.timeZone)
                : formatClockTime(mark.markedAt, props.timeZone);
            return (
              <MarkSheetRow
                key={mark.messageId}
                mark={mark}
                sender={sender}
                text={markRowText(message, titles.get(mark.messageId))}
                when={when}
                {...(mark.resolved
                  ? {
                      resolver: {
                        name: resolverName(mark, props.currentUserId, displayNameOf),
                        when:
                          mark.resolvedAt !== null
                            ? formatClockTime(mark.resolvedAt, props.timeZone)
                            : '',
                      },
                    }
                  : {})}
                confirming={confirming === mark.messageId}
                busy={busy}
                onJump={() => props.onJump(mark.messageId)}
                onAsk={() => setConfirming(mark.messageId)}
                onCancel={() => setConfirming(null)}
                onConfirm={() => void confirm(mark)}
              />
            );
          })}
        </ul>
      )}
      {props.preview !== undefined && rows.length > props.preview.rows
        ? props.preview.seeAll
        : null}
    </div>
  );
}

export function MarksSheet(props: MarksListProps & { onClose: () => void }): ReactElement {
  const { onClose, ...list } = props;
  return (
    <Sheet open={props.open} onClose={onClose} title="Marked messages">
      <MarksList {...list} />
    </Sheet>
  );
}

const PRIORITY_OPTIONS: ReadonlyArray<{ value: MarkPriority; label: string }> = [
  { value: 1, label: 'P1' },
  { value: 2, label: 'P2' },
  { value: null, label: 'No priority' },
];

/** Priority chooser for marking as pending, or changing an open pending mark. */
export function PrioritySheet(props: {
  open: boolean;
  title: string;
  current: MarkPriority | undefined;
  busy: boolean;
  onChoose: (priority: MarkPriority) => void;
  onClose: () => void;
}): ReactElement {
  return (
    <Sheet
      open={props.open}
      onClose={props.onClose}
      title={props.title}
      footer={
        <Button variant="ghost" size="lg" className="ml-auto" onClick={props.onClose}>
          Cancel
        </Button>
      }
    >
      <div className="flex flex-wrap gap-2">
        {PRIORITY_OPTIONS.map((option) => (
          <Chip
            key={option.label}
            label={option.label}
            size="tap"
            selected={props.current !== undefined && props.current === option.value}
            onClick={() => {
              if (!props.busy) props.onChoose(option.value);
            }}
          />
        ))}
      </div>
    </Sheet>
  );
}
