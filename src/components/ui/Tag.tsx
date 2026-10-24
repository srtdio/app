import { cn } from '@/lib/cn';

export type TagTone = 'neutral' | 'accent' | 'good' | 'warn' | 'bad';

/** Leading dot colour for a post stage; 'draft' (no stage token) reads neutral. */
export type TagDot = 'draft' | 'review' | 'approved' | 'rejected' | 'parked';

interface TagProps {
  label: string;
  tone?: TagTone;
  dot?: TagDot;
  className?: string;
}

export const TAG_TONE: Record<TagTone, string> = {
  neutral: 'bg-panel-2 text-fg-2',
  accent: 'bg-accent-soft text-accent',
  good: 'bg-good-soft text-good',
  warn: 'bg-panel-3 text-warn',
  bad: 'bg-bad-soft text-bad',
};

const DOT: Record<TagDot, string> = {
  draft: 'bg-fg-3',
  review: 'bg-stage-review',
  approved: 'bg-stage-approved',
  rejected: 'bg-stage-rejected',
  parked: 'bg-stage-parked',
};

/** Whether a raw stage string has a dot colour. */
export function isTagDot(value: string): value is TagDot {
  return value in DOT;
}

/** Classes for a tag in a tone. */
export function tagClass(tone: TagTone): string {
  return cn('inline-flex h-5 items-center rounded-md px-2 text-xs font-medium', TAG_TONE[tone]);
}

/** A static, non-interactive pill for a stage, status or mark. */
export function Tag({ label, tone = 'neutral', dot, className }: TagProps) {
  return (
    <span className={cn(tagClass(tone), dot !== undefined && 'gap-1.5', className)}>
      {dot !== undefined ? (
        <span aria-hidden="true" className={cn('h-2 w-2 shrink-0 rounded-full', DOT[dot])} />
      ) : null}
      {label}
    </span>
  );
}
