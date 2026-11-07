// When a chat task falls: the Tasks sheet's chips (Past, Today, This week,
// Later, No date), the date line under a row, the day choices (a new task's,
// and a row's menu), and the sheet's search. Due days are
// calendar days on the WORKSPACE zone ('YYYY-MM-DD', never turned back into an
// instant); the done time is a moment and reads on the device zone. Every
// function is pure: "now", the zone and the week start are passed in. Dates
// read through src/lib/time.ts only.

import { matchRuns } from '@/lib/chat/search';
import { addCivilDays } from '@/lib/list-sort';
import { weekBounds } from '@/lib/plan-week';
import { civilDay, formatDue, formatOverdue, formatAgo } from '@/lib/time';
import type { ChatTask } from '@/lib/chat/tasks';

export type TaskWhen = 'past' | 'today' | 'week' | 'later' | 'none';

/** The chips in order, with their labels. */
export const TASK_WHEN_CHIPS: ReadonlyArray<{ key: TaskWhen; label: string }> = [
  { key: 'past', label: 'Past' },
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'This week' },
  { key: 'later', label: 'Later' },
  { key: 'none', label: 'No date' },
];

/** The workspace calendar the chips read on. */
export interface TaskCalendar {
  /** The instant "today" is read from. */
  now: Date;
  /** The workspace IANA zone (a blank or unknown value reads as UTC). */
  timeZone: string;
  /** The workspace week start, 0=Sun..6=Sat. */
  weekStartDay: number;
}

/** Today and the last day of this week, 'YYYY-MM-DD', on the workspace calendar. Pure. */
export function calendarDays(cal: TaskCalendar): { today: string; weekEnd: string } {
  const bounds = weekBounds({
    now: cal.now,
    timeZone: cal.timeZone,
    weekStartDay: cal.weekStartDay,
    offset: 0,
  });
  return { today: civilDay(cal.now, cal.timeZone), weekEnd: bounds.end };
}

/**
 * The chip a task sits under: no date; before today (done or not: Past keeps
 * what was due and what happened); today; later this week; after this week. Pure.
 */
export function taskWhen(
  task: Pick<ChatTask, 'dueOn'>,
  days: { today: string; weekEnd: string },
): TaskWhen {
  const due = task.dueOn;
  if (due === null) return 'none';
  if (due < days.today) return 'past';
  if (due === days.today) return 'today';
  if (due <= days.weekEnd) return 'week';
  return 'later';
}

/** How many tasks each chip holds. Pure. */
export function countByWhen(
  tasks: readonly Pick<ChatTask, 'dueOn'>[],
  days: { today: string; weekEnd: string },
): Record<TaskWhen, number> {
  const out: Record<TaskWhen, number> = { past: 0, today: 0, week: 0, later: 0, none: 0 };
  for (const t of tasks) out[taskWhen(t, days)] += 1;
  return out;
}

/**
 * The chip the sheet opens on: Today when it holds anything, else the first
 * chip in order that does, else Today. Pure.
 */
export function openingChip(counts: Record<TaskWhen, number>): TaskWhen {
  if (counts.today > 0) return 'today';
  return TASK_WHEN_CHIPS.find((c) => counts[c.key] > 0)?.key ?? 'today';
}

/** What the line under a row says, and whether it reads in the bad (overdue) tone. */
export interface TaskDateLine {
  text: string;
  bad: boolean;
}

/**
 * The line under a row, or null when the chip already says it all:
 *   overdue: "Overdue 2d" (bad tone); today or undated: nothing
 *   tomorrow or later: "Due tomorrow", "Due Fri", "Due 2 Jan 2027" (formatDue)
 *   done with a date: "Due 31 Oct · done Mon"; done, no date: "Done 3h"
 * The done time is short (formatAgo). A done
 * task is never overdue; one with no done time (done before the stamp
 * existed) shows its due day alone. Due days read on the workspace zone. Pure.
 */
export function rowDateLine(
  task: Pick<ChatTask, 'dueOn' | 'status' | 'doneAt'>,
  cal: TaskCalendar,
): TaskDateLine | null {
  const { today } = calendarDays(cal);
  const due = task.dueOn;
  if (task.status === 'done') {
    const doneDay = task.doneAt !== null ? formatAgo(task.doneAt, cal.now, cal.timeZone) : '';
    if (due === null) return doneDay === '' ? null : { text: `Done ${doneDay}`, bad: false };
    const dueText = formatDue(due, cal.timeZone, cal.now);
    return { text: doneDay === '' ? dueText : `${dueText} · done ${doneDay}`, bad: false };
  }
  if (due === null || due === today) return null;
  if (due < today) return formatOverdue(due, cal.timeZone, cal.now);
  return { text: formatDue(due, cal.timeZone, cal.now), bad: false };
}

const TODAY_LABEL = 'Today';
const TOMORROW_LABEL = 'Tomorrow';

/** A quick day choice in a row's menu. */
export interface DayChoice {
  key: 'today' | 'tomorrow' | 'none';
  label: string;
  /** 'YYYY-MM-DD', or null for No date. */
  dueOn: string | null;
}

/** The quick choices (under the add row, and in a row's menu): Today, Tomorrow, No date. Pure. */
export function dayChoices(cal: TaskCalendar): DayChoice[] {
  const { today } = calendarDays(cal);
  return [
    { key: 'today', label: TODAY_LABEL, dueOn: today },
    { key: 'tomorrow', label: TOMORROW_LABEL, dueOn: addCivilDays(today, 1) },
    { key: 'none', label: 'No date', dueOn: null },
  ];
}

/** Whether a picked day is allowed (today or later; no back-dating). Pure. */
export function isPickableDay(dueOn: string, cal: TaskCalendar): boolean {
  return dueOn >= calendarDays(cal).today;
}

/**
 * The tasks a search keeps, across every chip: each query word starts a
 * word of the title (the app's one search rule, matchRuns: prefix, any case,
 * any script), so what is kept is exactly what the row highlights. No words
 * keeps everything. Pure.
 */
export function searchTasks<T extends Pick<ChatTask, 'title'>>(
  tasks: readonly T[],
  words: readonly string[],
): T[] {
  if (words.length === 0) return [...tasks];
  return tasks.filter((t) => {
    const hits = matchRuns(t.title, words)
      .filter((run) => run.hit)
      .map((run) => run.text.toLowerCase());
    return words.every((w) => hits.some((hit) => hit.startsWith(w)));
  });
}
