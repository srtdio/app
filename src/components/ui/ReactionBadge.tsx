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
 * The tap target: a ::before grown 14px above and below and 8px each side, so
 * the ~20px badge keeps its drawn size and hang while the touch area is at
 * least 44x44 (48 tall; a one-emoji badge is ~30 wide, so 46 wide).
 */
export const REACTION_BADGE_HIT =
  "before:absolute before:-inset-x-2 before:-inset-y-3.5 before:content-['']";

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
