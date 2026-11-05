// When a chat task falls: the Tasks page's sections (Overdue, Today, This
// week, Later, No date, and Done folded at the end), the date line under a row,
// the day choices a row's menu offers, and the page's search. Due days are
// calendar days on the WORKSPACE zone ('YYYY-MM-DD', never turned back into an
// instant); the done time is a moment and reads on the device zone. Every
// function is pure: "now", the zone and the week start are passed in. Dates
// read through src/lib/time.ts only.

import { matchRuns } from '@/lib/chat/search';
import { addCivilDays } from '@/lib/list-sort';
import { weekBounds } from '@/lib/plan-week';
import { civilDay, formatDate, formatDue, formatDueDate } from '@/lib/time';
import type { ChatTask } from '@/lib/chat/tasks';

export type TaskSection = 'overdue' | 'today' | 'week' | 'later' | 'none' | 'done';

/** The open sections in page order, with their labels; Done follows them, folded. */
export const TASK_SECTIONS: ReadonlyArray<{ key: Exclude<TaskSection, 'done'>; label: string }> = [
  { key: 'overdue', label: 'Overdue' },
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'This week' },
  { key: 'later', label: 'Later' },
  { key: 'none', label: 'No date' },
];

export const DONE_SECTION_LABEL = 'Done';

/** The workspace calendar the sections read on. */
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
 * The section a task sits in: done tasks under Done whatever their day; an
 * open task by its due day: none, before today (overdue), today, later this
 * week, after this week. Pure.
 */
export function taskSection(
  task: Pick<ChatTask, 'dueOn' | 'status'>,
  days: { today: string; weekEnd: string },
): TaskSection {
  if (task.status === 'done') return 'done';
  const due = task.dueOn;
  if (due === null) return 'none';
  if (due < days.today) return 'overdue';
  if (due === days.today) return 'today';
  if (due <= days.weekEnd) return 'week';
  return 'later';
}

type Sectionable = Pick<ChatTask, 'dueOn' | 'status' | 'doneAt' | 'number'>;

/**
 * The tasks of each section in reading order: open sections by due day then
 * number (undated by number); Done newest done first (never stamped: last,
 * by number). Pure, stable.
 */
export function groupBySection<T extends Sectionable>(
  tasks: readonly T[],
  days: { today: string; weekEnd: string },
): Record<TaskSection, T[]> {
  const out: Record<TaskSection, T[]> = {
    overdue: [],
    today: [],
    week: [],
    later: [],
    none: [],
    done: [],
  };
  for (const t of tasks) out[taskSection(t, days)].push(t);
  const byDay = (a: T, b: T): number =>
    (a.dueOn ?? '').localeCompare(b.dueOn ?? '') || a.number - b.number;
  for (const key of ['overdue', 'week', 'later'] as const) out[key].sort(byDay);
  const byNumber = (a: T, b: T): number => a.number - b.number;
  out.today.sort(byNumber);
  out.none.sort(byNumber);
  out.done.sort((a, b) => {
    if (a.doneAt === null || b.doneAt === null) {
      if (a.doneAt === b.doneAt) return byNumber(a, b);
      return a.doneAt === null ? 1 : -1;
    }
    return b.doneAt.localeCompare(a.doneAt) || byNumber(a, b);
  });
  return out;
}

/** What the line under a row says, and whether it reads in the bad (overdue) tone. */
export interface TaskDateLine {
  text: string;
  bad: boolean;
}

/**
 * The line under a row, or null when the section already says it all:
 *   overdue: "3 Nov" (bad tone); today or undated: nothing
 *   this week or later: "7 Nov"
 *   done with a date: "Due 31 Oct · done 30 Oct"; done, no date: "Done 30 Oct"
 * A done task with no done time (done before the stamp existed) shows its due
 * day alone. Due days read on the workspace zone, the done time on the device's. Pure.
 */
export function rowDateLine(
  task: Pick<ChatTask, 'dueOn' | 'status' | 'doneAt'>,
  cal: TaskCalendar,
  deviceZone?: string,
): TaskDateLine | null {
  const { today } = calendarDays(cal);
  const due = task.dueOn;
  if (task.status === 'done') {
    const doneDay = task.doneAt !== null ? formatDate(task.doneAt, cal.now, deviceZone) : '';
    if (due === null) return doneDay === '' ? null : { text: `Done ${doneDay}`, bad: false };
    const dueText = formatDue(due, cal.timeZone, cal.now);
    return { text: doneDay === '' ? dueText : `${dueText} · done ${doneDay}`, bad: false };
  }
  if (due === null || due === today) return null;
  return { text: formatDueDate(due, cal.timeZone, cal.now), bad: due < today };
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

/** The quick choices: Today, Tomorrow, No date. Pure. */
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
 * The tasks a search keeps, across every section: each query word starts a
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
