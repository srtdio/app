import { cn } from '@/lib/cn';

export type StatusDotStage = 'draft' | 'review' | 'approved' | 'rejected' | 'parked';

/** One colour per stage (the stage-* tokens; draft is fg-3). */
export const STATUS_DOT_TONE: Record<StatusDotStage, string> = {
  draft: 'bg-fg-3',
  review: 'bg-stage-review',
  approved: 'bg-stage-approved',
  rejected: 'bg-stage-rejected',
  parked: 'bg-stage-parked',
};

/** The one status dot: 8px, round, one colour per stage. Decorative (the label carries the word). */
export function StatusDot({ stage, className }: { stage: StatusDotStage; className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-status-dot={stage}
      className={cn(
        'inline-block h-2 w-2 shrink-0 rounded-full',
        STATUS_DOT_TONE[stage],
        className,
      )}
    />
  );
}
