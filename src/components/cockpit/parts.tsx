// Small shared pieces of the Cockpit's tabs: section labels, stat tiles, the
// status dot and the failed-source note.

import type { ReactNode } from 'react';
import { ErrorNote } from '@/components/ui/ErrorNote';
import { cn } from '@/lib/cn';
import { countText } from '@/lib/cockpit/format';
import type { DotLevel } from '@/lib/cockpit/types';

export const DOT_FILL: Record<DotLevel, string> = {
  green: 'bg-good',
  amber: 'bg-warn',
  red: 'bg-bad',
  grey: 'bg-fg-3',
};

/** A 10px status dot (8px with small). */
export function StatusDot({ level, small = false }: { level: DotLevel; small?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn('shrink-0 rounded-full', small ? 'h-2 w-2' : 'h-2.5 w-2.5', DOT_FILL[level])}
    />
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h3 className="text-sm font-semibold uppercase tracking-[0.06em] text-fg-2">{children}</h3>
  );
}

export function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <SectionLabel>{label}</SectionLabel>
      {children}
    </section>
  );
}

/** A grid of labelled numbers (the tab's own tiles). */
export function Stats({
  items,
  columns = 2,
}: {
  items: { label: string; value: number | null }[];
  columns?: 2 | 3 | 4;
}) {
  return (
    <dl
      className={cn(
        'grid gap-2',
        columns === 2 && 'grid-cols-2',
        columns === 3 && 'grid-cols-3',
        columns === 4 && 'grid-cols-2',
      )}
    >
      {items.map((item) => (
        <div
          key={item.label}
          className="flex min-w-0 flex-col gap-1 rounded-xl border border-border bg-panel px-3 py-2.5"
        >
          <dt className="truncate text-sm text-fg-2">{item.label}</dt>
          <dd className="font-mono text-2xl font-semibold tabular-nums text-fg">
            {item.value === null ? '-' : countText(item.value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A source that failed: its one line, never a blank. */
export function SourceNote({ reason }: { reason: string }) {
  return <ErrorNote>{reason}</ErrorNote>;
}

/** Open a vendor page in a new tab, never the app's own. */
export function openExternal(href: string): void {
  window.open(href, '_blank', 'noopener,noreferrer');
}
