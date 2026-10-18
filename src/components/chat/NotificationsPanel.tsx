// The chat bell's panel: title "Notifications", tabs Now / Upcoming.
//
// Now: Reminders (fired, unread, not snoozed: Snooze and Done; a tap opens the
// chat at the message and leaves the reminder), Mentions (a tap marks it read
// and opens the chat at the message), Scheduled (sent: a tap marks it read and
// opens the chat, "Clear sent" clears them all; failed: "Not sent" with the
// reason, Retry and Edit), Plans (the plan alerts: a tap marks it read and
// opens the plan, a deleted plan's row only toasts "This plan was deleted"),
// Tasks (a change or a missed due time: a tap marks it read and opens the chat
// with its task sheet on that item).
// Sections hide when empty; all empty reads "You're all caught up".
// Upcoming: pending Reminders (Change time, Cancel) and Scheduled messages (a
// tap opens that chat's scheduled sheet), soonest first; empty reads "Nothing
// coming up".
//
// Phone: the shared bottom Sheet (translateY only). Laptop: a popover anchored
// under the bell, max 70vh, scrolling, opacity only. Skeleton rows until the
// first load settles. Tokens only; 44px targets.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ComponentType, ReactElement, ReactNode, RefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import { createPortal } from 'react-dom';
import { Sheet } from '@/components/ui/Sheet';
import { Button } from '@/components/ui/Button';
import {
  IconAlarmClock,
  IconAt,
  IconCalendarClock,
  IconPlan,
  IconSend,
  IconTaskSquare,
} from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { NO_TOUCH_SELECT, type ChatLayout } from '@/components/chat/chat-type';
import { ReminderSheet } from '@/components/chat/ReminderSheet';
import { useBellOptional, type BellContextValue } from '@/components/chat/BellContext';
import {
  BELL_SNOOZE_OPTIONS,
  bellSections,
  failureInPlainWords,
  itemTitleOfEntry,
  mentionTitle,
  messagePreview,
  planBellLine,
  planTitleOfEntry,
  rowTime,
  scheduledPreview,
  sentTitle,
  type BellEntry,
} from '@/lib/chat/bell';
import { formatSendLabel } from '@/lib/chat/scheduled';
import { eventText, type TaskEventKind } from '@/lib/chat/tasks';
import { workspaceTimeZone } from '@/lib/chat/time-format';
import { chatMessageHref, taskLinkToken } from '@/lib/inbox/bell-types';
import type { ScheduledRow } from '@/lib/chat/scheduled';
import type { NameOf } from '@/lib/chat/mentions';
import { useViewerSide } from '@/lib/chat/viewer-role';
import { useWorkspace } from '@/lib/workspace-context';

export const NOTIFICATIONS_TITLE = 'Notifications';
export const BELL_EMPTY_NOW = "You're all caught up";
export const BELL_EMPTY_UPCOMING = 'Nothing coming up';
export const BELL_LOAD_FAILED = "Couldn't load notifications";
export const CANCEL_REMINDER_TITLE = 'Cancel this reminder?';
export const NOT_SENT_LABEL = 'Not sent';
export const NOTIFICATIONS_SUBTITLE = 'Your reminders, mentions and task alerts';
export const MARK_ALL_READ_LABEL = 'Mark all read';

export type BellTab = 'now' | 'upcoming';

/** The Now sections in display order, only those with rows. Pure. */
export function visibleNowSections(
  entries: readonly BellEntry[],
  hidden: ReadonlySet<string>,
  nowMs: number,
): {
  key: 'reminders' | 'mentions' | 'scheduled' | 'plans' | 'tasks';
  title: string;
  rows: BellEntry[];
}[] {
  const s = bellSections(
    entries.filter((e) => !hidden.has(e.id)),
    nowMs,
  );
  const all = [
    { key: 'reminders' as const, title: 'Reminders', rows: s.reminders },
    { key: 'mentions' as const, title: 'Mentions', rows: s.mentions },
    { key: 'scheduled' as const, title: 'Scheduled', rows: s.scheduled },
    { key: 'plans' as const, title: 'Plans', rows: s.plans },
    { key: 'tasks' as const, title: 'Tasks', rows: s.tasks },
  ];
  return all.filter((section) => section.rows.length > 0);
}

const ROW = 'flex flex-col gap-2 rounded-lg border border-border bg-panel-2 p-3';
const ACTION_BASE =
  'inline-flex h-11 min-w-[44px] items-center justify-center rounded-md px-3 text-[13px] font-medium transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:pointer-events-none disabled:opacity-50';
const ACTION = `${ACTION_BASE} border border-border bg-panel text-fg hover:bg-panel-3`;
const ACTION_PRIMARY = `${ACTION_BASE} bg-accent text-accent-fg hover:bg-accent-hover`;
const ACTION_DANGER = `${ACTION_BASE} border border-border bg-panel text-bad hover:bg-bad-soft`;

function RowIcon(props: { children: ReactNode; tone?: 'accent' | 'bad' }): ReactElement {
  return (
    <span
      className={cn(
        'flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-panel',
        props.tone === 'bad' ? 'text-bad' : 'text-accent',
      )}
    >
      {props.children}
    </span>
  );
}

/** The tappable body of a row: icon, a title line with the time, the preview and the chat name. */
function RowBody(props: {
  icon: ReactNode;
  title: ReactNode;
  time: string;
  preview: string;
  chat: string;
  onClick?: () => void;
  testId: string;
}): ReactElement {
  const inner = (
    <>
      {props.icon}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{props.title}</span>
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-fg-3">
            {props.time}
          </span>
        </span>
        {props.preview !== '' ? (
          <span className="truncate text-sm text-fg-2">{props.preview}</span>
        ) : null}
        <span className="truncate text-xs text-fg-3">{props.chat}</span>
      </span>
    </>
  );
  return props.onClick !== undefined ? (
    <button
      type="button"
      data-bell-open={props.testId}
      onClick={props.onClick}
      className="-m-1 flex min-h-[44px] items-start gap-3 rounded-md p-1 text-left hover:bg-panel-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      {inner}
    </button>
  ) : (
    <div className="flex items-start gap-3">{inner}</div>
  );
}

function ReminderRowView(props: { bell: BellContextValue; entry: BellEntry }): ReactElement {
  const { bell, entry } = props;
  const [snoozing, setSnoozing] = useState(false);
  const message = entry.messageId !== null ? bell.data.messages.get(entry.messageId) : undefined;
  const sender = message?.senderUserId != null ? bell.nameOf(message.senderUserId) : undefined;
  return (
    <li data-bell-row="reminder" data-bell-entry={entry.id} className={ROW}>
      <RowBody
        testId={entry.id}
        icon={
          <RowIcon>
            <IconAlarmClock size={18} />
          </RowIcon>
        }
        title={sender ?? 'Reminder'}
        time={rowTime(entry.createdAt, new Date())}
        preview={messagePreview(message, bell.nameOf)}
        chat={bell.chatNameOf(entry.channelId)}
        onClick={() => bell.openEntry(entry)}
      />
      {snoozing ? (
        <div
          data-bell-snooze-menu=""
          role="menu"
          aria-label="Snooze"
          className="grid grid-cols-2 gap-2"
        >
          {BELL_SNOOZE_OPTIONS.map((option) => (
            <button
              key={option.kind}
              type="button"
              role="menuitem"
              data-bell-snooze={option.kind}
              className={ACTION}
              onClick={() => {
                setSnoozing(false);
                void bell.snooze(entry, option.kind);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          data-bell-action="snooze"
          aria-expanded={snoozing}
          className={ACTION}
          onClick={() => setSnoozing((v) => !v)}
        >
          Snooze
        </button>
        <button
          type="button"
          data-bell-action="done"
          className={ACTION_PRIMARY}
          onClick={() => void bell.done(entry)}
        >
          Done
        </button>
      </div>
    </li>
  );
}

function MentionRowView(props: { bell: BellContextValue; entry: BellEntry }): ReactElement {
  const { bell, entry } = props;
  const message = entry.messageId !== null ? bell.data.messages.get(entry.messageId) : undefined;
  const actor = entry.actorId !== null ? (bell.nameOf(entry.actorId) ?? null) : null;
  return (
    <li data-bell-row="mention" data-bell-entry={entry.id} className={ROW}>
      <RowBody
        testId={entry.id}
        icon={
          <RowIcon>
            <IconAt size={18} />
          </RowIcon>
        }
        title={mentionTitle(actor)}
        time={rowTime(entry.createdAt, new Date())}
        preview={messagePreview(message, bell.nameOf)}
        chat={bell.chatNameOf(entry.channelId)}
        onClick={() => bell.openEntry(entry)}
      />
    </li>
  );
}

/**
 * A plan alert: the plan icon, the line (who did what to which plan), the
 * plan's title and "Plan". A tap marks it read and opens the plan; a deleted
 * plan's row opens nothing (it toasts).
 */
function PlanRowView(props: { bell: BellContextValue; entry: BellEntry }): ReactElement {
  const { bell, entry } = props;
  const { workspaceId } = useWorkspace();
  const { side } = useViewerSide(workspaceId);
  const plan = planTitleOfEntry(entry, bell.data.planTitles);
  const who = entry.actorId !== null ? (bell.nameOf(entry.actorId) ?? null) : null;
  const item = itemTitleOfEntry(entry, bell.data.itemTitles);
  const line = planBellLine(entry, { who, plan, item }, side);
  return (
    <li
      data-bell-row="plan"
      data-bell-plan={entry.eventType}
      data-bell-entry={entry.id}
      className={ROW}
    >
      <RowBody
        testId={entry.id}
        icon={
          <RowIcon>
            <IconPlan size={18} />
          </RowIcon>
        }
        title={line}
        time={rowTime(entry.createdAt, new Date())}
        preview={planRowPreview(item)}
        chat="Plan"
        onClick={() => bell.openEntry(entry)}
      />
    </li>
  );
}

/**
 * A plan row's preview: the item's title, or nothing when the alert names no
 * item. The line above already names the plan, so never the plan name twice. Pure.
 */
export function planRowPreview(item: string | null): string {
  return item ?? '';
}

const TASK_KINDS = new Set<string>([
  'created',
  'status',
  'priority',
  'due',
  'side',
  'title',
  'note',
  'due_passed',
]);

/**
 * A task row's line: task_changed "<actor> · <change>", task_due "<time>
 * passed · <n> <title>" (the payload's number and title; no extra read). Pure.
 */
export function taskBellLine(
  entry: Pick<BellEntry, 'eventType' | 'task'>,
  actor: string | null,
  nowMs: number,
  timeZone: string,
): string {
  const f = entry.task;
  const kind: TaskEventKind =
    entry.eventType === 'task_due'
      ? 'due_passed'
      : f?.kind != null && TASK_KINDS.has(f.kind)
        ? (f.kind as TaskEventKind)
        : 'note';
  const text = eventText(
    { kind, oldValue: f?.old ?? null, newValue: f?.new ?? null },
    { number: f?.number ?? null, title: f?.title ?? 'Item', side: null },
    nowMs,
    timeZone,
  );
  return entry.eventType === 'task_due' ? text : `${actor ?? 'Someone'} · ${text}`;
}

/**
 * A task alert: the task icon (alarm clock in bad for a missed due time), the
 * line and the chat. A tap marks it read and opens the chat with its task
 * sheet on that item.
 */
function TaskBellRowView(props: { bell: BellContextValue; entry: BellEntry }): ReactElement {
  const { bell, entry } = props;
  const { workspaces, workspaceId } = useWorkspace();
  const timeZone = workspaceTimeZone(workspaces.find((w) => w.id === workspaceId)?.timezone);
  const due = entry.eventType === 'task_due';
  const actor = entry.actorId !== null ? (bell.nameOf(entry.actorId) ?? null) : null;
  const taskId = entry.task?.taskId ?? null;
  return (
    <li data-bell-row={due ? 'task-due' : 'task'} data-bell-entry={entry.id} className={ROW}>
      <RowBody
        testId={entry.id}
        icon={
          <RowIcon {...(due ? { tone: 'bad' as const } : {})}>
            {due ? <IconAlarmClock size={18} /> : <IconTaskSquare size={18} />}
          </RowIcon>
        }
        title={
          <span className={due ? 'text-bad' : undefined}>
            {taskBellLine(entry, actor, Date.now(), timeZone)}
          </span>
        }
        time={rowTime(entry.createdAt, new Date())}
        preview="Task list"
        chat={bell.chatNameOf(entry.channelId)}
        onClick={() =>
          bell.openEntry(taskId !== null ? { ...entry, messageId: taskLinkToken(taskId) } : entry)
        }
      />
    </li>
  );
}

function ScheduledRowView(props: { bell: BellContextValue; entry: BellEntry }): ReactElement {
  const { bell, entry } = props;
  const chat = bell.chatNameOf(entry.channelId);
  if (entry.eventType === 'scheduled_sent') {
    const message = entry.messageId !== null ? bell.data.messages.get(entry.messageId) : undefined;
    return (
      <li data-bell-row="sent" data-bell-entry={entry.id} className={ROW}>
        <RowBody
          testId={entry.id}
          icon={
            <RowIcon>
              <IconSend size={18} />
            </RowIcon>
          }
          title={sentTitle(chat)}
          time={rowTime(entry.createdAt, new Date())}
          preview={messagePreview(message, bell.nameOf)}
          chat={chat}
          onClick={() => bell.openEntry(entry)}
        />
      </li>
    );
  }
  const row = entry.scheduledId !== null ? bell.data.failed.get(entry.scheduledId) : undefined;
  return (
    <li data-bell-row="failed" data-bell-entry={entry.id} className={ROW}>
      <RowBody
        testId={entry.id}
        icon={
          <RowIcon tone="bad">
            <IconCalendarClock size={18} />
          </RowIcon>
        }
        title={
          <span className="text-bad">
            {NOT_SENT_LABEL}
            <span className="font-normal text-fg-2">
              {' · '}
              {failureInPlainWords(row?.failure_reason ?? entry.reason)}
            </span>
          </span>
        }
        time={rowTime(entry.createdAt, new Date())}
        preview={scheduledPreview(row, bell.nameOf)}
        chat={chat}
      />
      <div className="flex justify-end gap-2">
        <button
          type="button"
          data-bell-action="edit"
          className={ACTION}
          onClick={() => bell.editFailed(entry)}
        >
          Edit
        </button>
        <button
          type="button"
          data-bell-action="retry"
          className={ACTION_PRIMARY}
          onClick={() => void bell.retryFailed(entry)}
        >
          Retry
        </button>
      </div>
    </li>
  );
}

function SectionTitle(props: { title: string; action?: ReactNode }): ReactElement {
  return (
    <div className="flex min-h-[44px] items-center justify-between gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-3">{props.title}</h3>
      {props.action}
    </div>
  );
}

/** Skeleton rows: the first paint until data settles. */
export function BellSkeleton(): ReactElement {
  return (
    <ul data-bell-skeleton="" aria-hidden="true" className="flex flex-col gap-3">
      {[0, 1, 2].map((i) => (
        <li key={i} className={cn(ROW, 'flex-row items-start gap-3')}>
          <span className="h-9 w-9 shrink-0 animate-pulse rounded-full bg-panel-3" />
          <span className="flex flex-1 flex-col gap-2 pt-1">
            <span className="h-3 w-2/5 animate-pulse rounded bg-panel-3" />
            <span className="h-3 w-4/5 animate-pulse rounded bg-panel-3" />
            <span className="h-3 w-1/4 animate-pulse rounded bg-panel-3" />
          </span>
        </li>
      ))}
    </ul>
  );
}

function Empty(props: { text: string }): ReactElement {
  return (
    <p data-bell-empty="" className="py-10 text-center text-sm text-fg-2">
      {props.text}
    </p>
  );
}

function LoadFailed(props: { onRetry: () => void }): ReactElement {
  return (
    <div data-bell-error="" className="flex flex-col items-center gap-3 py-10 text-center">
      <p className="text-sm text-fg-2">{BELL_LOAD_FAILED}</p>
      <Button type="button" size="lg" onClick={props.onRetry}>
        Retry
      </Button>
    </div>
  );
}

export function NowTab(props: { bell: BellContextValue }): ReactElement {
  const { bell } = props;
  const sections = visibleNowSections(bell.data.entries, bell.hiddenIds, Date.now());
  if (sections.length === 0) return <Empty text={BELL_EMPTY_NOW} />;
  return (
    <div className="flex flex-col gap-2">
      {sections.map((section) => (
        <section key={section.key} data-bell-section={section.key} className="flex flex-col">
          <SectionTitle
            title={section.title}
            action={
              section.key === 'scheduled' &&
              section.rows.some((e) => e.eventType === 'scheduled_sent') ? (
                <button
                  type="button"
                  data-bell-action="clear-sent"
                  className="h-11 rounded-md px-3 text-[13px] font-medium text-accent hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  onClick={() => void bell.clearSent()}
                >
                  Clear sent
                </button>
              ) : undefined
            }
          />
          <ul className="flex flex-col gap-3">
            {section.rows.map((entry) =>
              section.key === 'reminders' ? (
                <ReminderRowView key={entry.id} bell={bell} entry={entry} />
              ) : section.key === 'mentions' ? (
                <MentionRowView key={entry.id} bell={bell} entry={entry} />
              ) : section.key === 'plans' ? (
                <PlanRowView key={entry.id} bell={bell} entry={entry} />
              ) : section.key === 'tasks' ? (
                <TaskBellRowView key={entry.id} bell={bell} entry={entry} />
              ) : (
                <ScheduledRowView key={entry.id} bell={bell} entry={entry} />
              ),
            )}
          </ul>
        </section>
      ))}
      {bell.data.hasMore ? (
        <Button
          type="button"
          size="lg"
          variant="ghost"
          data-bell-more=""
          disabled={bell.loadingMore}
          onClick={bell.loadMore}
        >
          Show older
        </Button>
      ) : null}
    </div>
  );
}

export function UpcomingTab(props: { bell: BellContextValue }): ReactElement {
  const { bell } = props;
  const now = new Date();
  const reminders = bell.data.reminders.filter((r) => !bell.hiddenIds.has(r.id));
  const scheduled = bell.data.scheduled;
  if (reminders.length === 0 && scheduled.length === 0) return <Empty text={BELL_EMPTY_UPCOMING} />;
  return (
    <div className="flex flex-col gap-2">
      {reminders.length > 0 ? (
        <section data-bell-section="upcoming-reminders" className="flex flex-col">
          <SectionTitle title="Reminders" />
          <ul className="flex flex-col gap-3">
            {reminders.map((r) => (
              <li
                key={r.id}
                data-bell-row="upcoming-reminder"
                data-bell-reminder={r.id}
                className={ROW}
              >
                <RowBody
                  testId={r.id}
                  icon={
                    <RowIcon>
                      <IconAlarmClock size={18} />
                    </RowIcon>
                  }
                  title={bell.chatNameOf(r.channel_id)}
                  time={formatSendLabel(new Date(r.remind_at), now)}
                  preview={messagePreview(bell.data.messages.get(r.message_id), bell.nameOf)}
                  chat="Reminder"
                />
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    data-bell-action="change-time"
                    className={ACTION}
                    onClick={() => bell.changeReminderTime(r)}
                  >
                    Change time
                  </button>
                  <button
                    type="button"
                    data-bell-action="cancel-reminder"
                    className={ACTION_DANGER}
                    onClick={() => bell.askCancelReminder(r)}
                  >
                    Cancel
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {scheduled.length > 0 ? (
        <section data-bell-section="upcoming-scheduled" className="flex flex-col">
          <SectionTitle title="Scheduled messages" />
          <ul className="flex flex-col gap-3">
            {scheduled.map((row) => (
              <li key={row.id} data-bell-row="upcoming-scheduled" className={ROW}>
                <RowBody
                  testId={row.id}
                  icon={
                    <RowIcon>
                      <IconCalendarClock size={18} />
                    </RowIcon>
                  }
                  title={bell.chatNameOf(row.channel_id)}
                  time={formatSendLabel(new Date(row.send_at), now)}
                  preview={scheduledPreview(row, bell.nameOf)}
                  chat="Scheduled message"
                  onClick={() => bell.openScheduledChat(row.channel_id)}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/** Tabs plus the active tab's content. */
export function NotificationsPanel(props: { bell: BellContextValue }): ReactElement {
  const { bell } = props;
  const [tab, setTab] = useState<BellTab>('now');
  const markAllRead = bell.markAllRead;
  const canMarkAll = markAllRead !== undefined && bell.status === 'ready' && bell.unread > 0;
  return (
    <div data-bell-panel="" className={cn('flex flex-col gap-3', NO_TOUCH_SELECT)}>
      <div data-bell-header="" className="flex min-h-[44px] items-center gap-2">
        <p data-bell-subtitle="" className="min-w-0 flex-1 text-sm text-fg-2">
          {NOTIFICATIONS_SUBTITLE}
        </p>
        {canMarkAll ? (
          <button
            type="button"
            data-bell-action="mark-all-read"
            className="h-11 shrink-0 rounded-md px-3 text-[13px] font-medium text-accent hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            onClick={() => void markAllRead()}
          >
            {MARK_ALL_READ_LABEL}
          </button>
        ) : null}
      </div>
      <div
        role="tablist"
        aria-label={NOTIFICATIONS_TITLE}
        className="grid grid-cols-2 gap-1 rounded-lg bg-panel-2 p-1"
      >
        {(['now', 'upcoming'] as const).map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            data-bell-tab={key}
            onClick={() => setTab(key)}
            className={cn(
              'h-11 rounded-md text-sm font-medium transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              tab === key ? 'bg-panel text-fg shadow-sm' : 'text-fg-2 hover:text-fg',
            )}
          >
            {key === 'now' ? 'Now' : 'Upcoming'}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {bell.status === 'loading' ? (
          <BellSkeleton />
        ) : bell.status === 'error' ? (
          <LoadFailed onRetry={bell.reload} />
        ) : tab === 'now' ? (
          <NowTab bell={bell} />
        ) : (
          <UpcomingTab bell={bell} />
        )}
      </div>
    </div>
  );
}

/** Where the laptop popover sits: under the bell, right edges aligned, kept 8px inside. Pure. */
export function bellPopoverPosition(
  anchor: Pick<DOMRect, 'bottom' | 'right'>,
  viewportWidth: number,
  width: number,
): { top: number; left: number } {
  const left = Math.max(8, Math.min(anchor.right - width, viewportWidth - width - 8));
  return { top: anchor.bottom + 8, left };
}

const POPOVER_WIDTH = 380;

/** The laptop popover: anchored to the bell, max 70vh, scrolls; opacity only. */
function NotificationsPopover(props: {
  bell: BellContextValue;
  anchorRef: RefObject<HTMLElement>;
}): ReactElement | null {
  const { bell, anchorRef } = props;
  const open = bell.open;
  const setOpen = bell.setOpen;
  const rootRef = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = useState(open);
  const [shown, setShown] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (open) {
      setRendered(true);
      const raf = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(raf);
    }
    setShown(false);
    const timer = setTimeout(() => setRendered(false), 150);
    return () => clearTimeout(timer);
  }, [open]);

  useLayoutEffect(() => {
    if (!rendered) return;
    const rect = anchorRef.current?.getBoundingClientRect();
    if (rect !== undefined) setCoords(bellPopoverPosition(rect, window.innerWidth, POPOVER_WIDTH));
  }, [rendered, anchorRef]);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') setOpen(false);
    }
    function onPointer(event: Event): void {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) === true) return;
      if (anchorRef.current?.contains(target) === true) return;
      // A sheet opened from the popover (Change time, Cancel) is not "outside".
      if (target instanceof Element && target.closest('[role="dialog"]') !== null) return;
      setOpen(false);
    }
    function onResize(): void {
      setOpen(false);
    }
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('resize', onResize);
    };
  }, [open, setOpen, anchorRef]);

  if (!rendered) return null;
  return createPortal(
    <div
      ref={rootRef}
      role="dialog"
      aria-label={NOTIFICATIONS_TITLE}
      data-bell-popover=""
      className={cn(
        'fixed z-50 flex max-h-[70vh] w-[380px] max-w-[calc(100vw-16px)] flex-col overflow-hidden rounded-xl border border-border-strong bg-panel shadow-2xl transition-opacity duration-fast motion-reduce:transition-none',
        shown ? 'opacity-100 ease-enter' : 'opacity-0 ease-exit',
      )}
      style={{
        top: coords?.top ?? 0,
        left: coords?.left ?? 0,
        visibility: coords === null ? 'hidden' : 'visible',
      }}
    >
      <h2 className="border-b border-border px-4 py-3 text-[15px] font-semibold text-fg">
        {NOTIFICATIONS_TITLE}
      </h2>
      <div className="min-h-0 overflow-y-auto px-3 py-3">
        <NotificationsPanel bell={bell} />
      </div>
    </div>,
    document.body,
  );
}

/** The bell's surface: the bottom Sheet on touch, the anchored popover on a laptop. */
export function NotificationsSurface(props: {
  layout: ChatLayout;
  anchorRef: RefObject<HTMLElement>;
}): ReactElement | null {
  const bell = useBellOptional();
  if (bell === null) return null;
  if (props.layout === 'laptop') {
    return <NotificationsPopover bell={bell} anchorRef={props.anchorRef} />;
  }
  return (
    <Sheet open={bell.open} onClose={() => bell.setOpen(false)} title={NOTIFICATIONS_TITLE}>
      <NotificationsPanel bell={bell} />
    </Sheet>
  );
}

/** What the "Scheduled in this chat" sheet takes (ScheduledListSheet's props). */
export type ScheduledSheetComponent = ComponentType<
  {
    open: boolean;
    onClose: () => void;
    rows: readonly ScheduledRow[];
    nameOf: NameOf;
  } & BellContextValue['scheduledActions']
>;

/**
 * The "Scheduled in this chat" sheet, provided by the chat surface when it
 * loads (ChannelList). The bell mounts in the top bar on every screen, and a
 * static import here would pull the chat Composer into the app shell; so the
 * sheet is handed in, and before chat has loaded a scheduled row opens its chat.
 */
let scheduledSheet: ScheduledSheetComponent | null = null;

export function provideScheduledSheet(component: ScheduledSheetComponent): void {
  scheduledSheet = component;
}

/** No sheet yet (chat not loaded): open that chat instead, then close the bell. */
function OpenScheduledChat(props: { channelId: string; done: () => void }): null {
  const navigate = useNavigate();
  const { channelId, done } = props;
  useEffect(() => {
    done();
    navigate(chatMessageHref(channelId, null));
  }, [channelId, done, navigate]);
  return null;
}

/**
 * The sheets the bell opens over the chat: the reminder sheet (Remind me and
 * Change time), the cancel-reminder confirm and "Scheduled in this chat" for
 * one chat. Mounted once by ChatConnected inside the BellProvider.
 */
export function NotificationsSheets(): ReactElement | null {
  const bell = useBellOptional();
  if (bell === null) return null;
  const ScheduledSheet = scheduledSheet;
  return (
    <>
      <ReminderSheet
        open={bell.reminderTarget !== null}
        onClose={bell.closeReminder}
        preview={bell.reminderTarget?.preview ?? null}
        onPick={(at) => void bell.pickReminderTime(at)}
      />
      <Sheet
        open={bell.cancelTarget !== null}
        onClose={bell.closeCancel}
        title={CANCEL_REMINDER_TITLE}
        footer={
          <div className="flex w-full justify-end gap-2">
            <Button type="button" size="lg" onClick={bell.closeCancel}>
              Keep
            </Button>
            <Button
              type="button"
              size="lg"
              variant="danger"
              data-confirm-cancel-reminder=""
              onClick={() => void bell.confirmCancel()}
            >
              Cancel reminder
            </Button>
          </div>
        }
      >
        <p className="truncate text-sm text-fg-2">
          {bell.cancelTarget !== null
            ? messagePreview(bell.data.messages.get(bell.cancelTarget.message_id), bell.nameOf)
            : ''}
        </p>
      </Sheet>
      {ScheduledSheet !== null ? (
        <ScheduledSheet
          open={bell.scheduledSheet !== null}
          onClose={bell.closeScheduledSheet}
          rows={bell.scheduledSheet?.rows ?? []}
          nameOf={bell.nameOf}
          {...bell.scheduledActions}
        />
      ) : bell.scheduledSheet !== null ? (
        <OpenScheduledChat
          channelId={bell.scheduledSheet.channelId}
          done={() => {
            bell.closeScheduledSheet();
            bell.setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}
