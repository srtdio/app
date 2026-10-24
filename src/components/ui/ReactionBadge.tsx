import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * The reaction badge: under a chat bubble's bottom-left, overlapping its bottom
 * edge by 3px (the meta's box starts 3px up, so the badge never covers it on
 * any bubble width). About 20px tall, so it hangs 17px below the bubble.
 */
export const REACTION_BADGE_CLASS =
  'absolute left-2 top-[calc(100%-3px)] inline-flex items-center gap-0.5 rounded-full border border-border bg-panel px-1.5 py-0.5';

/**
 * The tap target: a 44x44 ::before centred on the badge, so the drawn badge
 * keeps its size and hang while the touch area meets the 44px minimum.
 */
export const REACTION_BADGE_HIT =
  "before:absolute before:left-1/2 before:top-1/2 before:h-11 before:w-11 before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']";

export interface ReactionBadgeProps {
  /** The spoken summary, e.g. "2 reactions: 👍 🎉". */
  label: string;
  onClick: () => void;
  /** The emoji run and the optional count. */
  children: ReactNode;
}

/** The one tappable badge under a bubble; opens the reactions sheet. */
export function ReactionBadge({ label, onClick, children }: ReactionBadgeProps) {
  return (
    <button
      type="button"
      data-reaction-badge=""
      aria-label={label}
      onClick={onClick}
      className={cn(
        REACTION_BADGE_CLASS,
        REACTION_BADGE_HIT,
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
      )}
    >
      {children}
    </button>
  );
}
