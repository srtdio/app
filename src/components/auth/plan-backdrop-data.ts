// Data for the blurred Plan month behind the auth card: a Monday-start month
// of the device's current date, every cell carrying a sample thumbnail that
// already ships under public/induction-sample/thumb/.

export const BACKDROP_THUMBS = [
  'look-1',
  'look-2',
  'look-3',
  'sunburst',
  'mono',
  'tailor',
  'dye',
  'bts',
  'runway',
  'ruffle',
  'ruffle-2',
  'trench',
  'thanks',
  'white',
  'street',
  'knit',
  'np-01',
  'np-02',
  'np-03',
  'np-04',
  'np-05',
  'np-06',
  'np-07',
  'np-08',
  'np-09',
  'np-10',
  'np-11',
  'np-12',
  'np-13',
  'np-14',
  'np-15',
  'np-16',
  'np-17',
  'np-18',
  'np-19',
] as const;

export interface BackdropCell {
  day: number;
  inMonth: boolean;
  isToday: boolean;
  thumb: string;
}

export function backdropThumbSrc(thumb: string): string {
  return `/induction-sample/thumb/${thumb}.jpg`;
}

export function backdropMonth(today: Date): BackdropCell[][] {
  const year = today.getFullYear();
  const month = today.getMonth();
  const first = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const lead = (first.getDay() + 6) % 7;
  // At least 5 rows so a 4-week February still fills the screen like Plan.
  const rows = Math.max(5, Math.ceil((lead + daysInMonth) / 7));
  const weeks: BackdropCell[][] = [];
  for (let row = 0; row < rows; row += 1) {
    const week: BackdropCell[] = [];
    for (let col = 0; col < 7; col += 1) {
      const index = row * 7 + col;
      const date = new Date(year, month, 1 - lead + index);
      week.push({
        day: date.getDate(),
        inMonth: date.getMonth() === month,
        isToday:
          date.getFullYear() === year &&
          date.getMonth() === month &&
          date.getDate() === today.getDate(),
        thumb: BACKDROP_THUMBS[index % BACKDROP_THUMBS.length] ?? BACKDROP_THUMBS[0],
      });
    }
    weeks.push(week);
  }
  return weeks;
}

/** Monday-first short weekday labels in the device locale. */
export function backdropWeekdays(): string[] {
  const format = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
  // 5 Jan 2026 is a Monday.
  return Array.from({ length: 7 }, (_, i) => format.format(new Date(2026, 0, 5 + i)));
}

export function backdropMonthLabel(today: Date): string {
  return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(today);
}
