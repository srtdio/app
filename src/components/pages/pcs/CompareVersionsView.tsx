// The version-compare view: the PCS main column while COMPARE MODE is active. It
// word-level diffs two snapshot captions and paints added / removed runs. Like
// ReadOnlyVersionView it is presentational and the page owns entering/leaving the
// mode; Back returns to the live, editable current version. Auto picks inline for
// small edits and side-by-side for large ones; the segmented control overrides it.
// On the guard path (captions too large to align) it falls back to a plain
// side-by-side with the stats still shown but no per-word marks.

import { cn } from '@/lib/cn';
import { GUTTER } from '@/components/ui/layout';
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { SECTION_LABEL } from '@/components/ui/Text';
import { formatRelative } from '@/lib/time';
import { useMinuteClock } from '@/components/ui/use-minute-clock';
import { diffSegments, type DiffKind, type DiffResult, type DiffSegment } from '@/lib/text-diff';

export type CompareViewMode = 'auto' | 'inline' | 'side';

interface CompareVersionsViewProps {
  fromVersionNumber: number;
  toVersionNumber: number;
  fromCreatedAt: string;
  toCreatedAt: string;
  /** Snapshot captions; either side may be null or empty. */
  fromCaption: string | null;
  toCaption: string | null;
  /** Leave compare mode and return to the live post. */
  onBack: () => void;
}

// The pure render model: props plus the segmented-control state the wrapper owns.
// Kept hookless so the unit env can call it directly and walk the tree.
interface CompareVersionsViewModel extends CompareVersionsViewProps {
  diff: DiffResult;
  mode: CompareViewMode;
  onModeChange: (mode: CompareViewMode) => void;
  /** The shared minute clock's instant; times read relative to it. Absent: the current instant. */
  now?: Date;
}

const MODES: ReadonlyArray<{ value: CompareViewMode; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'inline', label: 'Inline' },
  { value: 'side', label: 'Side by side' },
];

// Auto crosses to side-by-side once a quarter of the words moved; smaller edits
// read better woven inline.
const AUTO_SIDE_THRESHOLD = 25;

/** The effective layout: auto resolves against the change ratio, an explicit
 *  pick passes through. Exported so the auto rule is unit-testable. */
export function resolveCompareMode(mode: CompareViewMode, changedPct: number): 'inline' | 'side' {
  if (mode === 'auto') return changedPct >= AUTO_SIDE_THRESHOLD ? 'side' : 'inline';
  return mode;
}

function isEmptyCaption(caption: string | null): boolean {
  return caption === null || caption.trim() === '';
}

// The app's one past-time format (formatRelative: "just now", "5 min ago",
// "2 days ago"). Falls back to the raw value if unparseable.
function formatTimestamp(value: string, now: Date): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return formatRelative(value, now);
}

const NO_CAPTION = <span className="text-fg-3">No caption in this version.</span>;

// Render the segments a side keeps, marking add (green, underlined) and del
// (red-strikethrough) runs, each with an sr-only "added" / "removed" so the
// change never rests on colour alone; eq runs paint plain. `include` selects which kinds this side shows.
function renderMarked(
  segs: readonly DiffSegment[],
  include: (kind: DiffKind) => boolean,
): ReactNode[] {
  const out: ReactNode[] = [];
  // Keyed by where the run starts in the caption (stable for a given diff).
  let at = 0;
  segs.forEach((seg) => {
    const key = `${seg.kind}:${at}`;
    at += seg.text.length;
    if (!include(seg.kind)) return;
    if (seg.kind === 'add') {
      out.push(
        <span key={key} className="rounded-sm bg-good-soft text-good underline">
          <span className="sr-only">added </span>
          {seg.text}
        </span>,
      );
    } else if (seg.kind === 'del') {
      out.push(
        <span key={key} className="rounded-sm bg-bad-soft text-bad line-through">
          <span className="sr-only">removed </span>
          {seg.text}
        </span>,
      );
    } else {
      out.push(<span key={key}>{seg.text}</span>);
    }
  });
  return out;
}

function Panel({ label, children }: { label?: string; children: ReactNode }): ReactNode {
  return (
    <div className="rounded-xl border bg-panel p-4 lit-card">
      {label !== undefined ? <div className={cn(SECTION_LABEL, 'mb-2')}>{label}</div> : null}
      <p className="whitespace-pre-wrap text-base text-fg">{children}</p>
    </div>
  );
}

export function compareVersionsView({
  fromVersionNumber,
  toVersionNumber,
  fromCreatedAt,
  toCreatedAt,
  fromCaption,
  toCaption,
  onBack,
  diff,
  mode,
  onModeChange,
  now = new Date(),
}: CompareVersionsViewModel): ReactNode {
  const segs = diff.segs;
  const guarded = segs === null;
  const resolved = resolveCompareMode(mode, diff.changedPct);
  const fromEmpty = isEmptyCaption(fromCaption);
  const toEmpty = isEmptyCaption(toCaption);
  const earlierLabel = `v${fromVersionNumber} · earlier`;
  const laterLabel = `v${toVersionNumber} · later`;

  let body: ReactNode;
  if (guarded) {
    // Guard path: no alignment, so no marks. Show both captions in full.
    body = (
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Panel label={earlierLabel}>{fromEmpty ? NO_CAPTION : fromCaption}</Panel>
        <Panel label={laterLabel}>{toEmpty ? NO_CAPTION : toCaption}</Panel>
      </div>
    );
  } else if (resolved === 'inline') {
    body = <Panel>{fromEmpty && toEmpty ? NO_CAPTION : renderMarked(segs, () => true)}</Panel>;
  } else {
    body = (
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Panel label={earlierLabel}>
          {fromEmpty ? NO_CAPTION : renderMarked(segs, (kind) => kind !== 'add')}
        </Panel>
        <Panel label={laterLabel}>
          {toEmpty ? NO_CAPTION : renderMarked(segs, (kind) => kind !== 'del')}
        </Panel>
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col gap-6 py-6', GUTTER)}>
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-accent-soft px-4 py-3 text-accent lit-tint">
        <div className="flex min-w-0 flex-col">
          <span className="text-base font-medium">
            Comparing v{fromVersionNumber} → v{toVersionNumber}
          </span>
          <span className="text-sm text-fg-2">
            {formatTimestamp(fromCreatedAt, now)} → {formatTimestamp(toCreatedAt, now)}
          </span>
        </div>
        <span className="ml-auto font-mono text-base tabular-nums">
          <span className="text-good">+{diff.addedWords}</span>{' '}
          <span className="text-bad">−{diff.removedWords}</span>{' '}
          <span className="text-fg-2">{diff.changedPct}% changed</span>
        </span>
        <Button variant="default" onClick={onBack}>
          Back
        </Button>
      </div>

      {guarded ? (
        <p className="text-sm text-fg-3">
          These captions are too long to mark word by word; showing both in full.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <div className="inline-flex rounded-lg border border-border bg-panel-2 p-1 lit-well">
              {MODES.map((option) => {
                const active = mode === option.value;
                return (
                  <Button
                    key={option.value}
                    type="button"
                    variant={active ? 'primary' : 'ghost'}
                    aria-pressed={active}
                    onClick={() => onModeChange(option.value)}
                  >
                    {option.label}
                  </Button>
                );
              })}
            </div>
            {mode === 'auto' ? (
              <span className="text-sm text-fg-3">
                Auto chose {resolved === 'side' ? 'side by side' : 'inline'} for a {diff.changedPct}
                % change.
              </span>
            ) : null}
          </div>

          <div className="flex items-center gap-4 text-sm text-fg-3">
            <span className="inline-flex items-center gap-2">
              <span aria-hidden className="h-3 w-3 rounded-sm bg-good-soft" />
              Added
            </span>
            <span className="inline-flex items-center gap-2">
              <span aria-hidden className="h-3 w-3 rounded-sm bg-bad-soft" />
              Removed
            </span>
          </div>
        </>
      )}

      {body}
    </div>
  );
}

export function CompareVersionsView(props: CompareVersionsViewProps) {
  const [mode, setMode] = useState<CompareViewMode>('auto');
  const nowMs = useMinuteClock();
  // Renders at its final state on the first frame (never a fade).

  const diff = useMemo(
    () => diffSegments(props.fromCaption ?? '', props.toCaption ?? ''),
    [props.fromCaption, props.toCaption],
  );

  return (
    <div>
      {compareVersionsView({ ...props, diff, mode, onModeChange: setMode, now: new Date(nowMs) })}
    </div>
  );
}
