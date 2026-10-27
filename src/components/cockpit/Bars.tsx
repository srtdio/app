// Plain CSS bar charts for the Cockpit (no chart library): day columns and
// share rows. Numbers render in JetBrains Mono, tabular.

import { countText, dayOfMonth, shareText } from '@/lib/cockpit/format';

/** One column per day, scaled to the busiest day; the day of month under each. */
export function DayBars({
  label,
  days,
}: {
  label: string;
  days: { day: string; value: number }[];
}) {
  const max = Math.max(1, ...days.map((d) => d.value));
  return (
    <figure aria-label={label} className="m-0">
      <div className="flex h-24 items-end gap-1">
        {days.map((d) => (
          <div
            key={d.day}
            className="flex h-full min-w-0 flex-1 flex-col justify-end"
            title={`${d.day}: ${countText(d.value)}`}
          >
            <div
              className="w-full bg-accent"
              style={{
                height: `${Math.max(d.value > 0 ? 4 : 1, (d.value / max) * 100).toString()}%`,
              }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-1" aria-hidden="true">
        {days.map((d) => (
          <span
            key={d.day}
            className="min-w-0 flex-1 text-center font-mono text-xs tabular-nums text-fg-3"
          >
            {dayOfMonth(d.day)}
          </span>
        ))}
      </div>
      <figcaption className="sr-only">
        {days.map((d) => `${d.day}: ${countText(d.value)}`).join(', ')}
      </figcaption>
    </figure>
  );
}

/** One row per item: its name, a bar against the largest, the count and its share. */
export function ShareBars({ rows }: { rows: { key: string; name: string; value: number }[] }) {
  const total = rows.reduce((a, r) => a + r.value, 0);
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="flex flex-col gap-2.5">
      {rows.map((r) => (
        <li key={r.key} className="flex flex-col gap-1">
          <div className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-base text-fg">{r.name}</span>
            <span className="font-mono text-base tabular-nums text-fg">{countText(r.value)}</span>
            <span className="w-10 text-right font-mono text-sm tabular-nums text-fg-3">
              {shareText(r.value, total)}
            </span>
          </div>
          <div className="h-1.5 w-full bg-panel-2">
            <div
              className="h-full bg-accent"
              style={{ width: `${((r.value / max) * 100).toString()}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
