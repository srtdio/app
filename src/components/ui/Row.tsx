import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { PressableRow } from '@/components/ui/PressableRow';
import { textRole } from '@/components/ui/Text';
import { ICON_SIZE, IconChevronRight } from '@/components/ui/icons';

export interface RowProps {
  /** Leading avatar (32) or icon (20): held in a fixed 32 column so labels share one edge (L5). */
  leading?: ReactNode;
  /** Top line title (heading role). */
  title: ReactNode;
  /** Top line trailing time (meta role). */
  time?: ReactNode;
  /** Second line (secondary role): one line, truncated. Makes the row 72 tall. */
  secondary?: ReactNode;
  /** A chevron (the row opens somewhere) OR a ⋯ menu, never both. */
  trailing?:
    | { kind: 'chevron' }
    | { kind: 'more'; menu: ReactNode }
    | { kind: 'node'; node: ReactNode };
  /** Divider under the row, inset 60 (it starts on the text edge). */
  divider?: boolean;
  onPress?: () => void;
  disabled?: boolean;
  /** Current / chosen row: lit-selected. */
  selected?: boolean;
  className?: string;
  'aria-label'?: string;
}

/**
 * The one list row, built on PressableRow. 56 tall (one line + meta) or 72
 * (two lines); leading at the 16 inset, gap 12, text at 60; divider inset 60.
 * The ⋯ trailing is a sibling of the tap surface (buttons never nest) and
 * takes the trailing rule through ActionMenuTrigger.
 */
export function Row({
  leading,
  title,
  time,
  secondary,
  trailing,
  divider = false,
  onPress,
  disabled,
  selected = false,
  className,
  ...rest
}: RowProps) {
  const body = (
    <>
      {leading !== undefined ? (
        <span data-row-leading="" className="flex w-8 shrink-0 items-center justify-center">
          {leading}
        </span>
      ) : null}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className={textRole('heading', 'min-w-0 flex-1 truncate')}>{title}</span>
          {time !== undefined ? <span className={textRole('meta', 'shrink-0')}>{time}</span> : null}
        </span>
        {secondary !== undefined ? (
          <span className={textRole('secondary')}>{secondary}</span>
        ) : null}
      </span>
      {trailing?.kind === 'chevron' ? (
        <span aria-hidden="true" data-row-chevron="" className="flex shrink-0 text-fg-3">
          <IconChevronRight size={ICON_SIZE.control} />
        </span>
      ) : null}
    </>
  );
  const height = secondary !== undefined ? 'min-h-18' : 'min-h-14';
  return (
    <div data-row="" className={cn('relative flex min-w-0 items-center', className)}>
      {onPress !== undefined ? (
        <PressableRow
          onClick={onPress}
          disabled={disabled}
          aria-label={rest['aria-label']}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-3 rounded-none px-4',
            height,
            selected && 'lit-selected',
          )}
        >
          {body}
        </PressableRow>
      ) : (
        <div className={cn('flex min-w-0 flex-1 items-center gap-3 px-4', height)}>{body}</div>
      )}
      {trailing?.kind === 'more' ? (
        <span data-row-more="" className="flex shrink-0 pr-4">
          {trailing.menu}
        </span>
      ) : null}
      {trailing?.kind === 'node' ? (
        // The trailing rule for a caller's IconButton (a 44 box, pulled out by 12).
        <span data-row-trailing="" className="flex shrink-0 pr-4 [&>button]:-mr-3">
          {trailing.node}
        </span>
      ) : null}
      {divider ? (
        <span
          aria-hidden="true"
          data-row-divider=""
          className="pointer-events-none absolute bottom-0 left-15 right-0 h-px bg-border"
        />
      ) : null}
    </div>
  );
}
