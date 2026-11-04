// Presentational helpers shared by the prototype's screens. Labels, classes
// and tones are copied from plan-card.ts (postLine, planControlText,
// DRAFT_NOT_READY, planCountLabel) and PlanScreen.tsx (LINE_LABEL,
// POST_LINE_TONES, PILL_TONES, DayColumn, RowTile, PlanCommentCount), never
// imported, so no data module loads.

import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { ICON_SIZE, IconChat, IconImage } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { formatDueDate } from '@/lib/time';
import { WORKSPACE } from './fixtures';
import type { FixturePost, ReviewStatus, Stage } from './fixtures';

/** Section label role (design rules: sm/600 uppercase, fg-2). */
export const SECTION_LABEL = 'text-sm font-semibold uppercase tracking-[0.06em] text-fg-2';

/** PlanScreen.tsx LINE_LABEL: the PLAN / POST line label. */
export const LINE_LABEL = 'w-9 shrink-0 text-sm font-semibold uppercase tracking-[0.06em] text-fg-2';

/** plan-card.ts DRAFT_NOT_READY. */
export const DRAFT_NOT_READY = 'Not ready to view yet';

/** plan-card.ts POST_NOT_MADE_LABEL. */
export const POST_NOT_MADE_LABEL = 'Not made yet';

/** The pair's label on the linked post row. */
export const PAIR_LABEL = 'Post for this concept';

export type PostLineTone = Stage | 'none';

const POST_LINE_LABELS: Record<Stage, string> = {
  draft: 'Draft',
  review: 'Review',
  approved: 'Approved',
  parked: 'Parked',
  rejected: 'Rejected',
};

/** postLine(): the stage name as is ("Review", never "In review"), or "Not made yet". */
export function postLine(stage: Stage | null): { label: string; tone: PostLineTone } {
  if (stage === null) return { label: POST_NOT_MADE_LABEL, tone: 'none' };
  return { label: POST_LINE_LABELS[stage], tone: stage };
}

/** PlanScreen.tsx POST_LINE_TONES. */
export const POST_LINE_TONES: Record<PostLineTone, string> = {
  draft: 'text-fg-2',
  review: 'text-stage-review',
  approved: 'text-stage-approved',
  parked: 'text-stage-parked',
  rejected: 'text-stage-rejected',
  none: 'text-fg-2',
};

/** planControlText(). */
export function planText(status: ReviewStatus): string {
  if (status === 'approved') return 'OK';
  if (status === 'changes') return 'Not OK';
  return 'Not checked yet';
}

/** PlanScreen.tsx PLAN_TEXT_TONES. */
export const PLAN_TEXT_TONES: Record<ReviewStatus, string> = {
  approved: 'text-good',
  changes: 'text-bad',
  waiting: 'text-fg-2',
};

/** plan-card.ts STATUS_LABELS and PlanScreen.tsx PILL_TONES. */
export const STATUS_LABELS: Record<ReviewStatus, string> = {
  waiting: 'Waiting',
  approved: 'Approved',
  changes: 'Changes asked',
};
export const PILL_TONES: Record<ReviewStatus, string> = {
  approved: 'bg-good-soft text-good',
  changes: 'bg-panel-2 text-stage-review',
  waiting: 'bg-panel-2 text-fg-2',
};

/** "6 Nov" on the workspace zone (src/lib/time.ts). */
export function dueShort(day: string): string {
  return formatDueDate(day, WORKSPACE.timeZone);
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function weekday(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).getUTCDay()] ?? '';
}

/** "Fri 6 Nov" for a civil day. */
export function dayHeader(day: string): string {
  return `${weekday(day)} ${dueShort(day)}`;
}

/** "Text · 6 Nov". */
export function postMeta(post: FixturePost): string {
  return `${post.format} · ${dueShort(post.dueDate)}`;
}

/** Laptop vs phone, the app's 768px breakpoint (same rule as useIsLaptop). */
export function useLaptop(): boolean {
  const query = '(min-width: 768px)';
  const [laptop, setLaptop] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const on = (): void => setLaptop(list.matches);
    list.addEventListener('change', on);
    return () => list.removeEventListener('change', on);
  }, []);
  return laptop;
}

/** PlanScreen.tsx DayColumn (not today). */
export function DayTile(props: { day: string }): ReactElement {
  return (
    <div className="flex h-14 w-14 shrink-0 flex-col overflow-hidden rounded-lg border bg-panel lit-card">
      <span className="flex h-[18px] shrink-0 items-center justify-center whitespace-nowrap bg-panel-2 text-xs font-semibold uppercase leading-3 tracking-[0.06em] text-fg-2">
        {weekday(props.day)}
      </span>
      <span className="flex flex-1 items-center justify-center font-mono text-2xl font-medium leading-6 tabular-nums text-fg">
        {Number(props.day.slice(8, 10))}
      </span>
    </div>
  );
}

/** RowTile: a concept's image (placeholder), its dashed outline, or a text post's "Aa". */
export function RowTile(props: { kind: 'image' | 'concept' | 'text' | 'muted' }): ReactElement {
  if (props.kind === 'image') {
    return (
      <span
        data-plan-row-tile="concept-image"
        className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-panel-3 text-fg-3"
      >
        <IconImage size={ICON_SIZE.tray} />
      </span>
    );
  }
  if (props.kind === 'concept') {
    return (
      <span
        data-plan-row-tile="concept"
        className="h-14 w-14 shrink-0 rounded-lg border-[1.5px] border-dashed border-border-strong"
      />
    );
  }
  return (
    <span
      data-plan-row-tile="text"
      className={cn(
        'flex h-14 w-14 shrink-0 items-center justify-center rounded-lg text-xl font-semibold',
        props.kind === 'muted' ? 'bg-panel-2 text-fg-3' : 'bg-accent-soft text-accent',
      )}
    >
      {props.kind === 'muted' ? '' : 'Aa'}
    </span>
  );
}

/** TileColumn + PlanCommentCount: the tile, then the count under it (nothing for 0). */
export function TileColumn(props: { count: number; children: ReactElement }): ReactElement {
  return (
    <span className="flex w-14 shrink-0 flex-col items-center gap-1">
      {props.children}
      {props.count > 0 ? (
        <span
          role="img"
          aria-label={`${props.count} ${props.count === 1 ? 'comment' : 'comments'}`}
          className="inline-flex shrink-0 items-center gap-1 text-sm tabular-nums text-fg-2"
        >
          <IconChat size={ICON_SIZE.inline} />
          <span aria-hidden="true">{props.count}</span>
        </span>
      ) : null}
    </span>
  );
}

/** The POST line: an 8px dot and the stage, same colour (PlanStatusLines). */
export function PostLineView(props: { stage: Stage | null }): ReactElement {
  const post = postLine(props.stage);
  return (
    <div data-plan-line="post" className="flex min-h-[24px] items-center gap-3">
      <span className={LINE_LABEL}>POST</span>
      <span
        data-plan-post-status={post.tone}
        className={cn('flex min-w-0 items-center gap-2 text-md font-medium', POST_LINE_TONES[post.tone])}
      >
        <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-current" />
        <span className="truncate">{post.label}</span>
      </span>
    </div>
  );
}

/** The status-box pill (PlanPill). */
export function StatusPill(props: { status: ReviewStatus }): ReactElement {
  return (
    <span
      className={cn(
        'inline-flex min-h-[24px] items-center rounded-lg px-2 text-md lit-pill',
        PILL_TONES[props.status],
      )}
    >
      {STATUS_LABELS[props.status]}
    </span>
  );
}
