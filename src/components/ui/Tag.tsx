import type { ComponentType } from 'react';
import { cn } from '@/lib/cn';
import { ICON_SIZE, type IconProps } from '@/components/ui/icons';
import { CUT_LINE } from '@/components/ui/Text';

export type TagTone = 'neutral' | 'accent' | 'good' | 'warn' | 'bad';

/** Leading dot colour for a post stage; 'draft' (no stage token) reads neutral. */
export type TagDot = 'draft' | 'review' | 'approved' | 'rejected' | 'parked';

interface TagProps {
  label: string;
  tone?: TagTone;
  dot?: TagDot;
  /** A leading icon from ui/icons.tsx, at text size. Absent: today's markup. */
  icon?: ComponentType<IconProps>;
  /**
   * One line that ends in an ellipsis when the place is too narrow (ListCard's
   * line 2). Words only: with a dot or an icon the tag is clipped at the edge.
   */
  cut?: boolean;
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

/**
 * Classes for a tag in a tone. Never wider than its place (11 Nov 2026):
 * max-w-full, and what does not fit is clipped at the edge.
 */
export function tagClass(tone: TagTone): string {
  return cn(
    'lit-pill inline-flex h-5 items-center rounded-md px-2 text-xs font-medium max-w-full overflow-hidden',
    TAG_TONE[tone],
  );
}

/**
 * A cut tag (words only): the tag box itself is the one line and ends in an
 * ellipsis when its place is too narrow; the words stay its bare text. The
 * block display wins with ! so the tag keeps tagClass whole (and its 20 line
 * box keeps the words centred, CUT_LINE).
 */
export const TAG_CUT = `!inline-block text-ellipsis whitespace-nowrap align-middle ${CUT_LINE}`;

/** A static, non-interactive pill for a stage, status or mark. */
export function Tag({
  label,
  tone = 'neutral',
  dot,
  icon: Icon,
  cut = false,
  className,
}: TagProps) {
  return (
    <span
      className={cn(
        tagClass(tone),
        dot !== undefined && 'gap-2',
        Icon !== undefined && dot === undefined && 'gap-1',
        cut && dot === undefined && Icon === undefined && TAG_CUT,
        className,
      )}
    >
      {Icon !== undefined ? <Icon size={ICON_SIZE.text} className="shrink-0" /> : null}
      {dot !== undefined ? (
        <span aria-hidden="true" className={cn('h-2 w-2 shrink-0 rounded-full', DOT[dot])} />
      ) : null}
      {label}
    </span>
  );
}
