import type { ButtonHTMLAttributes, ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';

/** The one Load more label (9 Nov 2026): no count, no "Show N more". */
export const LOAD_MORE_LABEL = 'Load more';

/**
 * Load more under a list: the BUTTON level (soft grey, 44 tall), left aligned
 * (self-start, on the list's leading edge) in every list. Busy keeps the label
 * in place (Button busy: the arc over the hidden label), so the width never
 * changes while the next page reads. Each tap adds one screen's worth of rows
 * (getFillCount); the caller shows it only while the last page came back full.
 * `className` is for layout only (a gutter, a top gap), never a look.
 */
export function LoadMore({
  busy,
  onMore,
  className,
  ...rest
}: {
  busy: boolean;
  onMore: () => void;
  className?: string | undefined;
} & Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'onClick' | 'children' | 'className' | 'type' | 'disabled'
>): ReactElement {
  return (
    <Button
      {...rest}
      type="button"
      variant="secondary"
      data-load-more-part=""
      busy={busy}
      onClick={onMore}
      className={cn('self-start', className)}
    >
      {LOAD_MORE_LABEL}
    </Button>
  );
}
